// Derived EPUB-only View from foliate-js 341dc63cda7ad26b31ada4ee905e40b5020da88a.
// SPDX-License-Identifier: MIT
/*
MIT License

Copyright (c) 2022 John Factotum

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
*/
import { isHostPublication } from './publication.ts'
import { LIMITS } from './host-contract.ts'
import { SearchBudget, highlightSearchMatches } from './search-budget.ts'
import * as CFI from 'foliate-js/epubcfi.js'
import { TOCProgress, SectionProgress, PageProgress } from 'foliate-js/progress.js'
import { Overlayer } from 'foliate-js/overlayer.js'
import { textWalker } from 'foliate-js/text-walker.js'

const SEARCH_PREFIX = 'foliate-search:'

const NOTE_PREFIX = 'foliate-note:'

class CursorAutohider {
    #timeout
    #el
    #check
    #state
    constructor(el, check, state = {}) {
        this.#el = el
        this.#check = check
        this.#state = state
        if (this.#state.hidden) this.hide()
        this.#el.addEventListener('mousemove', ({ screenX, screenY }) => {
            // check if it actually moved
            if (screenX === this.#state.x && screenY === this.#state.y) return
            this.#state.x = screenX, this.#state.y = screenY
            this.show()
            if (this.#timeout) clearTimeout(this.#timeout)
            if (check()) this.#timeout = setTimeout(this.hide.bind(this), 1000)
        }, false)
    }
    cloneFor(el) {
        return new CursorAutohider(el, this.#check, this.#state)
    }
    #hasSelection() {
        const selection = this.#el.ownerDocument?.getSelection()
        return selection ? !selection.isCollapsed : false
    }
    hide() {
        // The pointer is what the reader aims a selection with, so leave it
        // alone while one stands: a paused drag, or a double-click word
        // select (which fires no mousemove at all), would otherwise blank it.
        if (this.#hasSelection()) return
        this.#el.style.cursor = 'none'
        this.#state.hidden = true
    }
    show() {
        this.#el.style.removeProperty('cursor')
        this.#state.hidden = false
    }
}

class History extends EventTarget {
    #arr = []
    #index = -1
    pushState(x) {
        const last = this.#arr[this.#index]
        if (last === x || last?.fraction && last.fraction === x.fraction) return
        this.#arr[++this.#index] = x
        this.#arr.length = this.#index + 1
        this.dispatchEvent(new Event('index-change'))
    }
    replaceState(x) {
        const index = this.#index
        this.#arr[index] = x
    }
    back() {
        const index = this.#index
        if (index <= 0) return
        const detail = { state: this.#arr[index - 1] }
        this.#index = index - 1
        this.dispatchEvent(new CustomEvent('popstate', { detail }))
        this.dispatchEvent(new Event('index-change'))
    }
    forward() {
        const index = this.#index
        if (index >= this.#arr.length - 1) return
        const detail = { state: this.#arr[index + 1] }
        this.#index = index + 1
        this.dispatchEvent(new CustomEvent('popstate', { detail }))
        this.dispatchEvent(new Event('index-change'))
    }
    get canGoBack() {
        return this.#index > 0
    }
    get canGoForward() {
        return this.#index < this.#arr.length - 1
    }
    clear() {
        this.#arr = []
        this.#index = -1
    }
}

const languageInfo = lang => {
    if (!lang) return {}
    try {
        const canonical = Intl.getCanonicalLocales(lang)[0]
        const locale = new Intl.Locale(canonical)
        const isCJK = ['zh', 'ja', 'kr'].includes(locale.language)
        const direction = (locale.getTextInfo?.() ?? locale.textInfo)?.direction
        return { canonical, locale, isCJK, direction }
    } catch (e) {
        console.warn(e)
        return {}
    }
}

export class View extends HTMLElement {
    #root = this.attachShadow({ mode: 'open' })
    #sectionProgress
    #tocProgress
    #pageProgress
    #cfiProgress
    #searchResults = new Map()
    #searchGeneration = 0
    #cursorAutohider = new CursorAutohider(this, () =>
        this.hasAttribute('autohide-cursor'))
    isFixedLayout = false
    lastLocation
    history = new History()
    constructor() {
        super()
        this.history.addEventListener('popstate', ({ detail }) => {
            const resolved = this.resolveNavigation(detail.state)
            this.renderer.goTo(resolved)
        })
    }
    async open(book) {
        // Loader provenance only: native rights are still checked per resource.
        if (!isHostPublication(book) || !Array.isArray(book.sections)
            || !book.sections.length || book.sections.length > LIMITS.resources)
            throw new TypeError('HOST_PUBLICATION_REQUIRED')
        this.book = book
        this.language = languageInfo(book.metadata?.language)

        if (book.splitTOCHref && book.getTOCFragment) {
            const ids = book.sections.map(s => s.id)
            this.#sectionProgress = new SectionProgress(book.sections, 1500, 1600)
            const splitHref = book.splitTOCHref.bind(book)
            const getFragment = book.getTOCFragment.bind(book)
            this.#tocProgress = new TOCProgress()
            await this.#tocProgress.init({
                toc: book.toc ?? [], ids, splitHref, getFragment })
            this.#pageProgress = new TOCProgress()
            await this.#pageProgress.init({
                toc: book.pageList ?? [], ids, splitHref, getFragment })
        }
        this.#cfiProgress = new PageProgress(book, this.resolveNavigation.bind(this))

        this.isFixedLayout = this.book.rendition?.layout === 'pre-paginated'
        if (this.isFixedLayout) {
            await import('foliate-js/fixed-layout.js')
            this.renderer = document.createElement('foliate-fxl')
        } else {
            await import('foliate-js/paginator.js')
            this.renderer = document.createElement('foliate-paginator')
        }
        this.renderer.setAttribute('exportparts', 'head,foot,filter,container')
        this.renderer.addEventListener('load', e => this.#onLoad(e.detail))
        this.renderer.addEventListener('relocate', e => this.#onRelocate(e.detail))
        this.renderer.addEventListener('create-overlayer', e =>
            e.detail.attach(this.#createOverlayer(e.detail)))
        this.renderer.open(book)
        this.#root.append(this.renderer)

    }
    close() {
        this.clearSearch() // Retire pending document/matcher work before destruction.
        this.renderer?.destroy()
        this.renderer?.remove()
        this.#sectionProgress = null
        this.#tocProgress = null
        this.#pageProgress = null
        this.#cfiProgress = null
        this.#searchResults = new Map()
        this.lastLocation = null
        this.history.clear()
    }
    goToTextStart() {
        return this.goTo(this.book.landmarks
            ?.find(m => m.type.includes('bodymatter') || m.type.includes('text'))
            ?.href ?? this.book.sections.findIndex(s => s.linear !== 'no'))
    }
    async init({ lastLocation, showTextStart }) {
        const resolved = lastLocation ? this.resolveNavigation(lastLocation) : null
        if (resolved) {
            await this.renderer.goTo(resolved)
            this.history.pushState(lastLocation)
        }
        else if (showTextStart) await this.goToTextStart()
        else {
            this.history.pushState(0)
            await this.next()
        }
    }
    #emit(name, detail, cancelable) {
        return this.dispatchEvent(new CustomEvent(name, { detail, cancelable }))
    }
    #onRelocate({ reason, range, index, fraction, size }) {
        const progress = this.#sectionProgress?.getProgress(index, fraction, size) ?? {}
        const tocItem = this.#tocProgress?.getProgress(index, range)
        const pageItem = this.#pageProgress?.getProgress(index, range)
        const cfi = this.getCFI(index, range)
        this.lastLocation = { ...progress, tocItem, pageItem, cfi, range }
        if (reason === 'snap' || reason === 'page' || reason === 'scroll')
            this.history.replaceState(cfi)
        this.#emit('relocate', this.lastLocation)
    }
    #onLoad({ doc, index }) {
        // set language and dir if not already set
        doc.documentElement.lang ||= this.language.canonical ?? ''
        if (!this.language.isCJK)
            doc.documentElement.dir ||= this.language.direction ?? ''

        this.#handleLinks(doc, index)
        this.#cursorAutohider.cloneFor(doc.documentElement)

        this.#emit('load', { doc, index })
    }
    #handleLinks(doc, index) {
        const { book } = this
        const section = book.sections[index]
        doc.addEventListener('click', e => {
            const a = e.target.closest('a[href]')
            if (!a) return
            e.preventDefault()
            const href_ = a.getAttribute('href')
            const href = section?.resolveHref?.(href_) ?? href_
            if (book?.isExternal?.(href))
                Promise.resolve(this.#emit('external-link', { a, href }, true))
                    .then(x => x ? globalThis.open(href, '_blank') : null)
                    .catch(e => console.error(e))
            else {
                let internalHref = href
                if (!book.resolveHref(href)) {
                    const hashIndex = href_.indexOf('#')
                    if (hashIndex >= 0) {
                        const hash = href_.slice(hashIndex)
                        internalHref = section?.resolveHref?.(hash) ?? href
                    }
                }
                Promise.resolve(this.#emit('link', { a, href: internalHref }, true))
                    .then(x => x ? this.goTo(internalHref) : null)
                    .catch(e => console.error(e))
            }
        })
    }
    async addAnnotation(annotation, remove) {
        const { value } = annotation
        if (value.startsWith(SEARCH_PREFIX)) {
            const generation = this.#searchGeneration
            const cfi = value.replace(SEARCH_PREFIX, '')
            const { index, anchor } = await this.resolveNavigation(cfi)
            if (generation !== this.#searchGeneration) return
            const obj = this.#getOverlayer(index)
            if (obj) {
                const { overlayer, doc } = obj
                if (remove) {
                    overlayer.remove(value)
                    return
                }
                const range = doc ? anchor(doc) : anchor
                if (range) overlayer.add(value, range, Overlayer.outline)
            }
            return
        } else if (value.startsWith(NOTE_PREFIX)) {
            const cfi = value.replace(NOTE_PREFIX, '')
            const { index, anchor } = await this.resolveNavigation(cfi)
            const obj = this.#getOverlayer(index)
            if (obj) {
                const { overlayer, doc } = obj
                if (remove) {
                    overlayer.remove(value)
                    return
                }
                const range = doc ? anchor(doc) : anchor
                if (range) {
                    const draw = (func, opts) => overlayer.add(value, range, func, opts)
                    this.#emit('draw-annotation', { draw, annotation, doc, range })
                }
            }
            return
        }
        const { index, anchor } = await this.resolveNavigation(value)
        const obj = this.#getOverlayer(index)
        if (obj) {
            const { overlayer, doc } = obj
            overlayer.remove(value)
            if (!remove) {
                const range = doc ? anchor(doc) : anchor
                if (range) {
                    const draw = (func, opts) => overlayer.add(value, range, func, opts)
                    this.#emit('draw-annotation', { draw, annotation, doc, range })
                }
            }
        }
        const label = this.#tocProgress?.getProgress(index)?.label ?? ''
        return { index, label }
    }
    deleteAnnotation(annotation) {
        return this.addAnnotation(annotation, true)
    }
    #getOverlayer(index) {
        return this.renderer.getContents()
            .find(x => x.index === index && x.overlayer)
    }
    #createOverlayer({ doc, index }) {
        const overlayer = new Overlayer(doc)
        doc.addEventListener('click', e => {
            const [value, range, rect] = overlayer.hitTest(e)
            if (value && !value.startsWith(SEARCH_PREFIX)) {
                this.#emit('show-annotation', { value, index, range, rect })
            }
        }, false)

        let lastHitTestTime = 0
        const THROTTLE_MS = 200
        const isAndroid = /Android/i.test(navigator.userAgent)

        doc.addEventListener('mousemove', (e) => {
            if (isAndroid) return
            const now = performance.now()
            if (now - lastHitTestTime < THROTTLE_MS) return
            lastHitTestTime = now
            const [value] = overlayer.hitTest(e)
            if (value && !value.startsWith(SEARCH_PREFIX)) {
                doc.body.style.cursor = 'pointer'
            } else {
                doc.body.style.cursor = ''
            }
        })

        const list = this.#searchResults.get(index)
        if (list) for (const item of list) this.addAnnotation(item)

        this.#emit('create-overlay', { index })
        return overlayer
    }
    async showAnnotation(annotation) {
        const { value } = annotation
        const resolved = await this.goTo(value)
        if (resolved) {
            const { index, anchor } = resolved
            const { doc } =  this.#getOverlayer(index)
            const range = anchor(doc)
            this.#emit('show-annotation', { value, index, range })
        }
    }
    getCFI(index, range) {
        const baseCFI = this.book.sections[index].cfi ?? CFI.fake.fromIndex(index)
        if (!range) return baseCFI
        return CFI.joinIndir(baseCFI, CFI.fromRange(range))
    }
    resolveCFI(cfi) {
        if (this.book.resolveCFI)
            return this.book.resolveCFI(cfi)
        else {
            const parts = CFI.parse(cfi)
            const index = CFI.fake.toIndex((parts.parent ?? parts).shift())
            const anchor = doc => CFI.toRange(doc, parts)
            return { index, anchor }
        }
    }
    resolveNavigation(target) {
        try {
            if (typeof target === 'number') return { index: target }
            if (typeof target.fraction === 'number') {
                const [index, anchor] = this.#sectionProgress.getSection(target.fraction)
                return { index, anchor }
            }
            if (CFI.isCFI.test(target)) return this.resolveCFI(target)
            return this.book.resolveHref(target)
        } catch (e) {
            console.error(e)
            console.error(`Could not resolve target ${target}`)
        }
    }
    async goTo(target) {
        const resolved = this.resolveNavigation(target)
        try {
            await this.renderer.goTo(resolved)
            this.history.pushState(target)
            return resolved
        } catch(e) {
            console.error(e)
            console.error(`Could not go to ${target}`)
        }
    }
    async goToFraction(frac) {
        const [index, anchor] = this.#sectionProgress.getSection(frac)
        await this.renderer.goTo({ index, anchor })
        this.history.pushState({ fraction: frac })
    }
    async select(target) {
        try {
            const obj = await this.resolveNavigation(target)
            await this.renderer.goTo({ ...obj, select: true })
            this.history.pushState(target)
        } catch(e) {
            console.error(e)
            console.error(`Could not go to ${target}`)
        }
    }
    deselect() {
        for (const { doc } of this.renderer.getContents())
            doc.defaultView.getSelection().removeAllRanges()
    }
    getSectionFractions() {
        return (this.#sectionProgress?.sectionFractions ?? [])
            .map(x => x + Number.EPSILON)
    }
    getProgressOf(index, range) {
        const tocItem = this.#tocProgress?.getProgress(index, range)
        const pageItem = this.#pageProgress?.getProgress(index, range)
        return { tocItem, pageItem }
    }
    async getCFIProgress(cfi) {
        const progress = await this.#cfiProgress?.getProgress(cfi)
        if (!progress || progress.index === -1) return null
        return this.#sectionProgress?.getProgress(progress.index, progress.fraction)
    }
    async getTOCItemOf(target) {
        try {
            const { index, anchor } = await this.resolveNavigation(target)
            const doc = await this.book.sections[index].createDocument()
            const frag = anchor(doc)
            const isRange = frag instanceof Range
            const range = isRange ? frag : doc.createRange()
            if (!isRange) range.selectNodeContents(frag)
            return this.#tocProgress?.getProgress(index, range)
        } catch(e) {
            console.error(e)
            console.error(`Could not get ${target}`)
        }
    }
    async prev(distance) {
        await this.renderer.prev(distance)
    }
    async next(distance) {
        await this.renderer.next(distance)
    }
    async pan(dx, dy) {
        await this.renderer.pan(dx, dy)
    }
    isOverflowX() {
        return this.renderer.isOverflowX
    }
    isOverflowY() {
        return this.renderer.isOverflowY
    }
    goLeft() {
        return this.book.dir === 'rtl' ? this.next() : this.prev()
    }
    goRight() {
        return this.book.dir === 'rtl' ? this.prev() : this.next()
    }
    // The private profile supports contains only: one CFI per admitted match.
    #toSearchMatch(index, { range, excerpt }) {
        const cfi = this.getCFI(index, range)
        return { cfi, excerpt }
    }
    async * #searchSection(matcher, query, index, budget, active) {
        if (!active() || !budget.remaining) return
        const doc = await this.book.sections[index].createDocument()
        if (!active()) return
        yield* budget.mapMatches(matcher(doc, query),
            match => this.#toSearchMatch(index, match), active)
    }
    async * #searchBook(matcher, query, budget, active) {
        const { sections } = this.book
        for (const [index, { createDocument }] of sections.entries()) {
            if (!active() || !budget.remaining) return
            if (!createDocument) continue
            const doc = await createDocument()
            if (!active()) return
            // Array.from sees at most the global remaining budget. The wrapper
            // stops BEFORE matcher.next() can allocate another range/excerpt.
            const subitems = Array.from(budget.mapMatches(matcher(doc, query),
                match => this.#toSearchMatch(index, match), active))
            const progress = (index + 1) / sections.length
            if (!active()) return
            yield { progress }
            if (!active()) return
            if (subitems.length) yield { index, subitems }
        }
    }
    async * search(opts) {
        this.clearSearch()
        const generation = this.#searchGeneration
        const book = this.book
        const active = () => generation === this.#searchGeneration && book === this.book
        const budget = new SearchBudget()
        const { query, index } = opts
        if (typeof query !== 'string' || !query.length || query.length > LIMITS.searchChars
            || !book || index != null && (!Number.isInteger(index) || index < 0 || index >= book.sections.length))
            throw new TypeError('INVALID_SEARCH')
        const { searchMatcher } = await import('foliate-js/search.js')
        if (!active()) return
        // No regex/nearby-words or caller-supplied result replay in this profile.
        const matcher = searchMatcher(textWalker,
            { defaultLocale: this.language.canonical, mode: 'contains',
                matchCase: false, matchWholeWords: false })
        const iter = index != null
            ? this.#searchSection(matcher, query, index, budget, active)
            : this.#searchBook(matcher, query, budget, active)

        const list = []
        const seen = new Set()
        if (!active()) return
        this.#searchResults.set(index, list)
        const addHighlights = (matches, sink, sinkSeen) => {
            highlightSearchMatches(matches, sinkSeen, cfi => {
                const item = { value: SEARCH_PREFIX + cfi }
                sink.push(item)
                this.addAnnotation(item)
            }, active)
        }

        for await (const result of iter) {
            if (!active()) return
            if (result.subitems){
                const sectionList = []
                const sectionSeen = new Set()
                addHighlights(result.subitems, sectionList, sectionSeen)
                if (!active()) return
                this.#searchResults.set(result.index, sectionList)
                yield {
                    index: result.index,
                    label: this.#tocProgress?.getProgress(result.index)?.label ?? '',
                    subitems: result.subitems,
                }
            }
            else {
                if (result.cfi) addHighlights([result], list, seen)
                if (!active()) return
                yield result
            }
        }
        if (active()) yield 'done'
    }
    clearSearch() {
        ++this.#searchGeneration
        for (const list of this.#searchResults.values())
            for (const item of list) this.deleteAnnotation(item)
        this.#searchResults.clear()
    }
}

customElements.define('dani-epub-view', View)
