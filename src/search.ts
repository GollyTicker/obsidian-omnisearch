import { Notice } from 'obsidian'
import MiniSearch, { type Options, type SearchResult } from 'minisearch'
import {
  chsRegex,
  type IndexedNote,
  type ResultNote,
  minisearchCacheFilePath,
  type SearchMatch,
  SPACE_OR_PUNCTUATION,
} from './globals'
import {
  isFileIndexable,
  isFilePlaintext,
  removeDiacritics,
  stringsToRegex,
  stripMarkdownCharacters,
  wait,
} from './utils'
import type { Query } from './query'
import { settings } from './settings'
// import {
//   getNoteFromCache,
//   isCacheOutdated,
//   loadNotesCache,
//   resetNotesCache,
// } from './notes'
import * as NotesIndex from './notes-index'
import PQueue from 'p-queue-compat'
import { cacheManager } from './cache-manager'

export let minisearchInstance: MiniSearch<IndexedNote>

const tokenize = (text: string): string[] => {
  const tokens = text.split(SPACE_OR_PUNCTUATION)
  const chsSegmenter = (app as any).plugins.plugins['cm-chs-patch']

  if (chsSegmenter) {
    return tokens.flatMap(word =>
      chsRegex.test(word) ? chsSegmenter.cut(word) : [word]
    )
  } else return tokens
}

/**
 * Initializes the MiniSearch instance,
 * and adds all the notes to the index
 */
export async function initGlobalSearchIndex(): Promise<void> {
  const options: Options<IndexedNote> = {
    tokenize,
    processTerm: (term: string) =>
      (settings.ignoreDiacritics ? removeDiacritics(term) : term).toLowerCase(),
    idField: 'path',
    fields: [
      'basename',
      'aliases',
      'content',
      'headings1',
      'headings2',
      'headings3',
    ],
    storeFields: ['tags'],
  }

  // Default instance
  minisearchInstance = new MiniSearch(options)

  // Load Minisearch cache, if it exists
  if (await app.vault.adapter.exists(minisearchCacheFilePath)) {
    try {
      const json = await cacheManager.readMinisearchIndex()
      if (json) {
        // If we have cache data, reload it
        minisearchInstance = MiniSearch.loadJSON(json, options)
      }
      console.log('Omnisearch - MiniSearch index loaded from the file')
    } catch (e) {
      console.trace(
        'Omnisearch - Could not load MiniSearch index from the file'
      )
      console.error(e)
    }
  }

  // if (!minisearchInstance) {
  //   resetNotesCache()
  // }

  // Index files that are already present
  const start = new Date().getTime()

  const allFiles = app.vault.getFiles().filter(f => isFilePlaintext(f.path))

  let files
  let notesSuffix
  if (settings.persistCache) {
    files = allFiles.filter(file => cacheManager.isCacheOutdated(file))
    notesSuffix = 'modified notes'
  } else {
    files = allFiles
    notesSuffix = 'notes'
  }

  if (files.length > 0) {
    console.log(`Omnisearch - Indexing ${files.length} ${notesSuffix}`)
  }

  // Read and index all the files into the search engine
  const queue = new PQueue({ concurrency: 10 })
  for (const file of files) {
    if (cacheManager.getNoteFromCache(file.path)) {
      NotesIndex.removeFromIndex(file.path)
    }
    queue.add(() => NotesIndex.addToIndexAndCache(file))
  }

  await queue.onEmpty()

  if (files.length > 0) {
    const message = `Omnisearch - Indexed ${files.length} ${notesSuffix} in ${
      new Date().getTime() - start
    }ms`

    console.log(message)

    if (settings.showIndexingNotices) {
      new Notice(message)
    }

    await cacheManager.writeMinisearchIndex(minisearchInstance)

    // PDFs are indexed later, since they're heavier
    await NotesIndex.indexPDFs()
  }
}

/**
 * Searches the index for the given query,
 * and returns an array of raw results
 * @param query
 * @returns
 */
async function search(query: Query): Promise<SearchResult[]> {
  if (!query.segmentsToStr()) return []

  let results = minisearchInstance.search(query.segmentsToStr(), {
    prefix: true,
    fuzzy: term => (term.length > 4 ? 0.2 : false),
    combineWith: 'AND',
    boost: {
      basename: settings.weightBasename,
      aliases: settings.weightBasename,
      headings1: settings.weightH1,
      headings2: settings.weightH2,
      headings3: settings.weightH3,
    },
  })

  // Downrank files that are in Obsidian's excluded list
  if (settings.respectExcluded) {
    results.forEach(result => {
      if (
        app.metadataCache.isUserIgnored &&
        app.metadataCache.isUserIgnored(result.id)
      ) {
        result.score /= 3 // TODO: make this value configurable or toggleable?
      }
    })
  }

  // If the search query contains quotes, filter out results that don't have the exact match
  const exactTerms = query.getExactTerms()
  if (exactTerms.length) {
    results = results.filter(r => {
      const title =
        cacheManager.getNoteFromCache(r.id)?.path.toLowerCase() ?? ''
      const content = stripMarkdownCharacters(
        cacheManager.getNoteFromCache(r.id)?.content ?? ''
      ).toLowerCase()
      return exactTerms.every(q => content.includes(q) || title.includes(q))
    })
  }

  // If the search query contains exclude terms, filter out results that have them
  const exclusions = query.exclusions
  if (exclusions.length) {
    results = results.filter(r => {
      const content = stripMarkdownCharacters(
        cacheManager.getNoteFromCache(r.id)?.content ?? ''
      ).toLowerCase()
      return exclusions.every(q => !content.includes(q.value))
    })
  }
  return results
}

/**
 * Parses a text against a regex, and returns the { string, offset } matches
 * @param text
 * @param reg
 * @returns
 */
export function getMatches(text: string, reg: RegExp): SearchMatch[] {
  let match: RegExpExecArray | null = null
  const matches: SearchMatch[] = []
  let count = 0 // TODO: FIXME: this is a hack to avoid infinite loops
  while ((match = reg.exec(text)) !== null) {
    if (++count > 100) break
    const m = match[0]
    if (m) matches.push({ match: m, offset: match.index })
  }
  return matches
}

/**
 * Searches the index, and returns an array of ResultNote objects.
 * If we have the singleFile option set,
 * the array contains a single result from that file
 * @param query
 * @param options
 * @returns
 */
export async function getSuggestions(
  query: Query,
  options?: Partial<{ singleFilePath: string | null }>
): Promise<ResultNote[]> {
  // Get the raw results
  let results = await search(query)
  if (!results.length) return []

  // Extract tags from the query
  const tags = query.segments
    .filter(s => s.value.startsWith('#'))
    .map(s => s.value)

  // Either keep the 50 first results,
  // or the one corresponding to `singleFile`
  if (options?.singleFilePath) {
    const result = results.find(r => r.id === options.singleFilePath)
    if (result) results = [result]
    else results = []
  } else {
    results = results.slice(0, 50)

    // Put the results with tags on top
    for (const tag of tags) {
      for (const result of results) {
        if ((result.tags ?? []).includes(tag)) {
          result.score *= 100
        }
      }
    }
  }

  // Map the raw results to get usable suggestions
  return results.map(result => {
    const note = cacheManager.getNoteFromCache(result.id)
    if (!note) {
      throw new Error(`Note "${result.id}" not indexed`)
    }

    // Remove '#' from tags, for highlighting
    query.segments.forEach(s => {
      s.value = s.value.replace(/^#/, '')
    })
    // Clean search matches that match quoted expressions,
    // and inject those expressions instead
    const foundWords = [
      // Matching terms from the result,
      // do not necessarily match the query
      ...Object.keys(result.match),

      // // Matching terms from the query,
      // // but only if they stem from the result's matches
      // ...Object.keys(result.match).filter(w =>
      //   query.segments.some(s => w.startsWith(s.value)),
      // ),

      // Quoted expressions
      ...query.segments.filter(s => s.exact).map(s => s.value),

      // Tags, starting with #
      ...tags,
    ]

    const matches = getMatches(note.content, stringsToRegex(foundWords))
    const resultNote: ResultNote = {
      score: result.score,
      foundWords,
      matches,
      ...note,
    }
    return resultNote
  })
}
