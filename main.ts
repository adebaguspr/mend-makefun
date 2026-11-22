// main.ts is mend, the CLI SPEC.md specifies, and this is the kit's starting point for it (MIT). It does sections 1 to 4, 9 and 10 of SPEC.md: the command line, the output and
// exit codes, safe paths, format detection, JSON edits and the all-or-nothing write. The other three formats are
// detected and then read as holding no edit, so they answer `error: parse 1`: reading unified diffs (section 6),
// SEARCH/REPLACE blocks (section 7) and V4A patches (section 8), and matching lines at three tiers (section 5), are
// yours to write. Node 22, the standard library alone; run it as `node main.ts [options] [PATCH]`.
//
// In a trial the grader runs `node /bot/main.ts` with MAKEFUN_ENV_URL set, and then this file hands over to runner.ts
// (the last lines below): keep that hand-over and runner.ts as they are, and write the CLI.

import { mkdirSync, readFileSync, rmSync, statSync, writeFileSync, writeSync } from 'node:fs';
import { dirname } from 'node:path';

const FORMATS = ['auto', 'unified', 'search-replace', 'v4a', 'json'];

class Exit2 {
  readonly line: string;
  constructor(line: string) {
    this.line = line;
  }
}
class Fail {
  readonly code: string;
  readonly path: string;
  constructor(code: string, path: string) {
    this.code = code;
    this.path = path;
  }
}

const blank = (s: string): boolean => s.trim() === '';

function patchLines(text: string): string[] {
  if (text === '') return [];
  const lines = text.split('\n');
  if (text.endsWith('\n')) lines.pop();
  return lines.map((l) => (l.endsWith('\r') ? l.slice(0, -1) : l));
}

function safe(p: string): boolean {
  return p !== '' && !p.startsWith('/') && !p.includes('\\') && p.split('/').every((s) => s !== '' && s !== '.' && s !== '..');
}

/** The tree as the edits leave it: changed paths in `now` (null: deleted), the rest read from disk. */
class Tree {
  private readonly orig = new Map<string, string | null>();
  readonly now = new Map<string, string | null>();
  original(p: string): string | null {
    if (!this.orig.has(p)) {
      let v: string | null = null;
      try {
        if (statSync(p).isFile()) v = readFileSync(p, 'utf8');
      } catch {
        v = null;
      }
      this.orig.set(p, v);
    }
    return this.orig.get(p)!;
  }
  get(p: string): string | null {
    return this.now.has(p) ? this.now.get(p)! : this.original(p);
  }
}

type Edit = (tree: Tree) => void;

/** Successful move edits of this run, for the `R <old> -> <new>` output lines. */
const MOVES: [string, string][] = [];

/** A file as lines plus its own break and whether it ends with one (SPEC.md section 3). */
interface Model {
  lines: string[];
  br: string;
  final: boolean;
}

function toModel(text: string): Model {
  if (text === '') return { lines: [], br: '\n', final: false };
  const nl = text.indexOf('\n');
  const br = nl > 0 && text[nl - 1] === '\r' ? '\r\n' : '\n';
  const final = text.endsWith(br);
  const lines = text.split(br);
  if (final) lines.pop();
  return { lines, br, final };
}

function fromModel(m: Model): string {
  return m.lines.length === 0 ? '' : m.lines.join(m.br) + (m.final ? m.br : '');
}

const trimEndWs = (s: string): string => s.replace(/[ \t]+$/, '');
const trimWs = (s: string): string => s.replace(/^[ \t]+/, '').replace(/[ \t]+$/, '');
const leadWs = (s: string): string => /^[ \t]*/.exec(s)![0]!;

/** One line of N: its text, and for a context line the index of its line in O. */
interface NLine {
  text: string;
  ctx: number; // index into O, or -1
}

/** Finds O in the file's lines at the first tier with an occurrence (SPEC.md section 5). */
function findOccurrences(fileLines: string[], O: string[], strict: boolean): { tier: number; at: number[] } | null {
  if (O.length === 0) return null;
  const tiers = strict ? [0] : [0, 1, 2];
  for (const tier of tiers) {
    const norm = (s: string): string => (tier === 0 ? s : tier === 1 ? trimEndWs(s) : trimWs(s));
    const want = O.map(norm);
    const at: number[] = [];
    for (let i = 0; i + O.length <= fileLines.length; i++) {
      let ok = true;
      for (let k = 0; k < O.length; k++) {
        if (norm(fileLines[i + k]!) !== want[k]) {
          ok = false;
          break;
        }
      }
      if (ok) at.push(i);
    }
    if (at.length > 0) return { tier, at };
  }
  return null;
}

/** The lines N writes for a match of O at `pos`, honouring context lines and tier 2 re-indenting. */
function writtenLines(fileLines: string[], pos: number, O: string[], N: NLine[], tier: number): string[] {
  let F = '';
  let P = '';
  if (tier === 2 && O.length > 0) {
    F = leadWs(fileLines[pos] ?? '');
    P = leadWs(O[0]!);
  }
  return N.map((n) => {
    if (n.ctx >= 0) return fileLines[pos + n.ctx]!;
    if (tier === 2 && n.text !== '' && trimWs(n.text) !== '' && n.text.startsWith(P)) return F + n.text.slice(P.length);
    return n.text;
  });
}

/** Replaces the O-length match at `pos` in the model with what N writes. */
function spliceModel(m: Model, pos: number, O: string[], N: NLine[], tier: number): void {
  const written = writtenLines(m.lines, pos, O, N, tier);
  m.lines.splice(pos, O.length, ...written);
}

function detect(lines: string[]): string | null {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) return null;
  if (lines[first]!.trim() === '*** Begin Patch') return 'v4a';
  const c = lines[first]!.trimStart()[0];
  if (c === '[' || c === '{') return 'json';
  if (lines.some((l) => l.trimEnd() === '<<<<<<< SEARCH')) return 'search-replace';
  if (lines.some((l, i) => l.startsWith('diff --git ') || (l.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')))) return 'unified';
  return null;
}

/** One JSON edit object (SPEC.md section 9), or null when it is not one. */
function jsonEdit(v: unknown): Edit | null {
  if (v === null || typeof v !== 'object' || Array.isArray(v)) return null;
  const o = v as Record<string, unknown>;
  const p = o.path;
  if (typeof p !== 'string') return null;
  const exists = (tree: Tree): string => {
    if (!safe(p)) throw new Fail('unsafe', p);
    const t = tree.get(p);
    if (t === null) throw new Fail('missing', p);
    return t;
  };
  if (o.command === 'create' && typeof o.file_text === 'string') {
    const text = o.file_text;
    return (tree) => {
      if (!safe(p)) throw new Fail('unsafe', p);
      if (tree.get(p) !== null) throw new Fail('exists', p);
      tree.now.set(p, text);
    };
  }
  if (o.command === 'str_replace' && typeof o.old_str === 'string' && o.old_str !== '' && (o.new_str === undefined || typeof o.new_str === 'string')) {
    const oldStr = o.old_str;
    const newStr = (o.new_str as string | undefined) ?? '';
    return (tree) => {
      const before = exists(tree);
      const nl = before.indexOf('\n');
      const crlf = nl > 0 && before[nl - 1] === '\r';
      const lf = (s: string): string => (crlf ? s.replaceAll('\r\n', '\n') : s);
      const t = lf(before);
      const old = lf(oldStr);
      let count = 0;
      for (let k = t.indexOf(old); k >= 0; k = t.indexOf(old, k + 1)) count += 1;
      if (count === 0) throw new Fail('no-match', p);
      if (count > 1) throw new Fail('ambiguous', p);
      const at = t.indexOf(old);
      const out = t.slice(0, at) + lf(newStr) + t.slice(at + old.length);
      tree.now.set(p, crlf ? out.replaceAll('\n', '\r\n') : out);
    };
  }
  if (o.command === 'insert' && typeof o.insert_line === 'number' && Number.isInteger(o.insert_line) && typeof o.new_str === 'string') {
    const line = o.insert_line;
    const add = patchLines(o.new_str);
    return (tree) => {
      const before = exists(tree);
      const nl = before.indexOf('\n');
      const br = nl > 0 && before[nl - 1] === '\r' ? '\r\n' : '\n';
      const lines = before === '' ? [] : before.split(br);
      const final = before !== '' && before.endsWith(br);
      if (final) lines.pop();
      if (line < 0 || line > lines.length) throw new Fail('no-match', p);
      lines.splice(line, 0, ...add);
      tree.now.set(p, lines.length === 0 ? '' : lines.join(br) + (final ? br : ''));
    };
  }
  return null;
}

function jsonEdits(text: string, lines: string[]): Edit[] {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) throw new Exit2('error: parse 1');
  const edits: Edit[] = [];
  if (lines[first]!.trimStart().startsWith('[')) {
    let v: unknown;
    try {
      v = JSON.parse(text);
    } catch {
      throw new Exit2(`error: parse ${first + 1}`);
    }
    if (!Array.isArray(v)) throw new Exit2(`error: parse ${first + 1}`);
    for (const x of v) {
      const e = jsonEdit(x);
      if (e === null) throw new Exit2(`error: parse ${first + 1}`);
      edits.push(e);
    }
    return edits;
  }
  lines.forEach((l, i) => {
    if (blank(l)) return;
    let e: Edit | null = null;
    try {
      e = jsonEdit(JSON.parse(l));
    } catch {
      e = null;
    }
    if (e === null) throw new Exit2(`error: parse ${i + 1}`);
    edits.push(e);
  });
  return edits;
}

interface Hunk {
  a: number;
  O: string[];
  N: NLine[];
  noBreak: boolean; // a `\` line follows the hunk's last context or `+` line
}

interface Section {
  oldPath: string | null;
  newPath: string | null;
  create: boolean;
  del: boolean;
  hunks: Hunk[];
  startLine: number;
}

/** Reads unified diffs (SPEC.md section 6) into edits. */
function unifiedEdits(lines: string[], strict: boolean): Edit[] {
  const sections: Section[] = [];
  const isDiff = (l: string): boolean => l.startsWith('diff --git ');
  const isPair = (i: number): boolean => (lines[i] ?? '').startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ');
  const hunkHead = (l: string): { a: number } | null => {
    const m = /^@@ -(\d+)(?:,\d+)? \+\d+(?:,\d+)? @@/.exec(l);
    return m ? { a: parseInt(m[1]!, 10) } : null;
  };
  const headPath = (l: string): string => {
    let p = l.slice(4);
    const tab = p.indexOf('\t');
    if (tab >= 0) p = p.slice(0, tab);
    p = p.trim();
    if (p.startsWith('a/') || p.startsWith('b/')) p = p.slice(2);
    return p;
  };

  let i = 0;
  while (i < lines.length) {
    const l = lines[i]!;
    let sec: Section | null = null;
    if (isDiff(l)) {
      const m = /^diff --git a\/(.*) b\/(.*)$/.exec(l);
      if (!m) throw new Exit2(`error: parse ${i + 1}`);
      sec = { oldPath: m[1]!, newPath: m[2]!, create: false, del: false, hunks: [], startLine: i + 1 };
      i += 1;
    } else if (isPair(i)) {
      sec = { oldPath: headPath(l), newPath: headPath(lines[i + 1]!), create: false, del: false, hunks: [], startLine: i + 1 };
      i += 2;
    } else if (l.startsWith('@@')) {
      throw new Exit2(`error: parse ${i + 1}`);
    } else {
      i += 1;
      continue;
    }
    sections.push(sec);
    // The section's header, up to its first hunk or the next section.
    let headerDone = false;
    while (i < lines.length && !headerDone) {
      const h = lines[i]!;
      if (isDiff(h)) break;
      if (isPair(i)) {
        sec.oldPath = headPath(h);
        sec.newPath = headPath(lines[i + 1]!);
        i += 2;
        continue;
      }
      if (h.startsWith('@@')) {
        if (!hunkHead(h)) throw new Exit2(`error: parse ${i + 1}`);
        headerDone = true;
        break;
      }
      if (h.startsWith('--- ')) throw new Exit2(`error: parse ${i + 2}`);
      if (h.startsWith('rename from ')) sec.oldPath = h.slice(12).trim();
      else if (h.startsWith('rename to ')) sec.newPath = h.slice(10).trim();
      else if (h.startsWith('new file mode')) sec.create = true;
      else if (h.startsWith('deleted file mode')) sec.del = true;
      i += 1;
    }
    // The section's hunks.
    while (i < lines.length) {
      const h = lines[i]!;
      if (isDiff(h) || isPair(i)) break;
      const head = hunkHead(h);
      if (!head) {
        if (h.startsWith('@@')) throw new Exit2(`error: parse ${i + 1}`);
        i += 1; // prose between hunks or sections
        continue;
      }
      i += 1;
      const body: { t: string; s: string }[] = [];
      while (i < lines.length) {
        const b = lines[i]!;
        if (isDiff(b) || isPair(i)) break;
        const c = b[0];
        if (c === ' ' || c === '-' || c === '+' || c === '\\') {
          body.push({ t: c, s: b.slice(1) });
          i += 1;
        } else if (b === '') {
          body.push({ t: ' ', s: '' });
          i += 1;
        } else break;
      }
      while (body.length > 0 && body[body.length - 1]!.t === ' ' && body[body.length - 1]!.s === '') body.pop();
      const O: string[] = [];
      const N: NLine[] = [];
      let lastNew = -1;
      body.forEach((b, k) => {
        if (b.t === ' ') {
          O.push(b.s);
          N.push({ text: b.s, ctx: O.length - 1 });
          lastNew = k;
        } else if (b.t === '-') O.push(b.s);
        else if (b.t === '+') {
          N.push({ text: b.s, ctx: -1 });
          lastNew = k;
        }
      });
      const noBreak = lastNew >= 0 && body[lastNew + 1]?.t === '\\';
      sec.hunks.push({ a: head.a, O, N, noBreak });
    }
  }
  if (sections.length === 0) throw new Exit2('error: parse 1');
  return sections.map((sec) => unifiedSection(sec, strict));
}

function unifiedSection(sec: Section, strict: boolean): Edit {
  return (tree) => {
    const isCreate = sec.create || sec.oldPath === '/dev/null';
    const isDelete = sec.del || sec.newPath === '/dev/null';
    if (isCreate) {
      const p = sec.newPath;
      if (p === null) throw new Exit2(`error: parse ${sec.startLine}`);
      if (!safe(p)) throw new Fail('unsafe', p);
      if (tree.get(p) !== null) throw new Fail('exists', p);
      const out: string[] = [];
      let noBreak = false;
      for (const h of sec.hunks) {
        let hasPlus = false;
        for (const n of h.N) {
          if (n.ctx < 0) {
            out.push(n.text);
            hasPlus = true;
          }
        }
        if (hasPlus) noBreak = h.noBreak;
      }
      tree.now.set(p, out.length === 0 ? '' : out.join('\n') + (noBreak ? '' : '\n'));
      return;
    }
    if (isDelete) {
      const p = sec.oldPath;
      if (p === null) throw new Exit2(`error: parse ${sec.startLine}`);
      if (!safe(p)) throw new Fail('unsafe', p);
      if (tree.get(p) === null) throw new Fail('missing', p);
      tree.now.set(p, null);
      return;
    }
    const oldP = sec.oldPath;
    const newP = sec.newPath;
    if (oldP === null || newP === null) throw new Exit2(`error: parse ${sec.startLine}`);
    if (!safe(oldP)) throw new Fail('unsafe', oldP);
    if (!safe(newP)) throw new Fail('unsafe', newP);
    const before = tree.get(oldP);
    if (before === null) throw new Fail('missing', oldP);
    const isMove = oldP !== newP;
    if (isMove && tree.get(newP) !== null) throw new Fail('exists', newP);
    const m = toModel(before);
    let d = 0;
    for (const h of sec.hunks) {
      if (h.O.length === 0) {
        const at = Math.min(h.a + d, m.lines.length);
        const atEnd = at === m.lines.length;
        m.lines.splice(at, 0, ...h.N.map((n) => n.text));
        if (atEnd) m.final = !h.noBreak;
        d += h.N.length;
        continue;
      }
      const found = findOccurrences(m.lines, h.O, strict);
      if (!found) throw new Fail('no-match', oldP);
      const target = h.a - 1 + d;
      let best = found.at[0]!;
      for (const p of found.at) if (Math.abs(p - target) < Math.abs(best - target)) best = p;
      const touchesEnd = best + h.O.length === m.lines.length;
      spliceModel(m, best, h.O, h.N, found.tier);
      if (touchesEnd) m.final = !h.noBreak;
      d += h.N.length - h.O.length;
    }
    tree.now.set(newP, fromModel(m));
    if (isMove) {
      tree.now.set(oldP, null);
      MOVES.push([oldP, newP]);
    }
  };
}

/** Reads SEARCH/REPLACE blocks (SPEC.md section 7) into edits. */
function searchReplaceEdits(lines: string[], strict: boolean): Edit[] {
  interface Block {
    path: string | null;
    old: string[];
    new: string[];
    searchLine: number;
  }
  const blocks: Block[] = [];
  let prevPath: string | null = null;
  let searchFrom = 0;
  let i = 0;
  while (i < lines.length) {
    if (lines[i]!.trimEnd() !== '<<<<<<< SEARCH') {
      i += 1;
      continue;
    }
    const searchLine = i + 1;
    let path: string | null = null;
    for (let k = i - 1; k >= searchFrom; k--) {
      const cand = lines[k]!;
      if (blank(cand)) continue;
      if (cand.trim().startsWith('```')) continue;
      path = cand.trim();
      break;
    }
    if (path === null) path = prevPath;
    if (path === null) throw new Exit2(`error: parse ${searchLine}`);
    i += 1;
    const old: string[] = [];
    let split = false;
    while (i < lines.length) {
      if (lines[i]!.trimEnd() === '=======') {
        split = true;
        i += 1;
        break;
      }
      old.push(lines[i]!);
      i += 1;
    }
    const neu: string[] = [];
    let closed = false;
    if (split) {
      while (i < lines.length) {
        if (lines[i]!.trimEnd() === '>>>>>>> REPLACE') {
          closed = true;
          i += 1;
          break;
        }
        neu.push(lines[i]!);
        i += 1;
      }
    }
    if (!split || !closed) throw new Exit2(`error: parse ${searchLine}`);
    blocks.push({ path, old, new: neu, searchLine });
    prevPath = path;
    searchFrom = i;
  }
  if (blocks.length === 0) throw new Exit2('error: parse 1');
  return blocks.map((b) => {
    const p = b.path!;
    const O = b.old;
    const N: NLine[] = b.new.map((t) => ({ text: t, ctx: -1 }));
    return (tree: Tree) => {
      if (!safe(p)) throw new Fail('unsafe', p);
      if (O.length === 0) {
        if (tree.get(p) !== null) throw new Fail('exists', p);
        tree.now.set(p, N.length === 0 ? '' : N.map((n) => n.text).join('\n') + '\n');
        return;
      }
      const before = tree.get(p);
      if (before === null) throw new Fail('missing', p);
      const m = toModel(before);
      const found = findOccurrences(m.lines, O, strict);
      if (!found) throw new Fail('no-match', p);
      if (found.at.length > 1) throw new Fail('ambiguous', p);
      spliceModel(m, found.at[0]!, O, N, found.tier);
      tree.now.set(p, fromModel(m));
    };
  });
}

/** Reads V4A patches (SPEC.md section 8) into edits. */
function v4aEdits(lines: string[], strict: boolean): Edit[] {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) throw new Exit2('error: parse 1');
  if (lines[first]!.trim() !== '*** Begin Patch') throw new Exit2(`error: parse ${first + 1}`);
  let last = lines.length - 1;
  while (last > first && blank(lines[last]!)) last -= 1;
  if (lines[last]!.trim() !== '*** End Patch') throw new Exit2(`error: parse ${lines.length + 1}`);

  interface Chunk {
    anchor: string | null;
    eof: boolean;
    O: string[];
    N: NLine[];
  }
  interface VSection {
    kind: 'add' | 'del' | 'upd';
    path: string;
    line: number;
    addLines: string[];
    moveTo: string | null;
    chunks: Chunk[];
  }
  const sections: VSection[] = [];
  const secHead = (l: string): { kind: VSection['kind']; path: string } | null => {
    for (const [pre, kind] of [['*** Add File:', 'add'], ['*** Delete File:', 'del'], ['*** Update File:', 'upd']] as const) {
      if (l.startsWith(pre)) return { kind, path: l.slice(pre.length).trim() };
    }
    return null;
  };
  let i = first + 1;
  while (i < last) {
    const l = lines[i]!;
    if (blank(l)) {
      i += 1;
      continue;
    }
    const head = secHead(l);
    if (!head) throw new Exit2(`error: parse ${i + 1}`);
    const sec: VSection = { kind: head.kind, path: head.path, line: i + 1, addLines: [], moveTo: null, chunks: [] };
    sections.push(sec);
    i += 1;
    // The section's body, up to the next section or the end.
    const bodyStart = i;
    let bodyEnd = i;
    while (bodyEnd < last && !secHead(lines[bodyEnd]!)) bodyEnd += 1;
    const body = lines.slice(bodyStart, bodyEnd);
    i = bodyEnd;
    if (sec.kind === 'add') {
      let end = body.length;
      while (end > 0 && blank(body[end - 1]!)) end -= 1;
      for (let k = 0; k < end; k++) {
        const b = body[k]!;
        if (b.startsWith('+')) sec.addLines.push(b.slice(1));
        else if (b === '') sec.addLines.push('');
        else throw new Exit2(`error: parse ${bodyStart + k + 1}`);
      }
    } else if (sec.kind === 'del') {
      for (let k = 0; k < body.length; k++) {
        if (!blank(body[k]!)) throw new Exit2(`error: parse ${bodyStart + k + 1}`);
      }
    } else {
      let k = 0;
      if (k < body.length && body[k]!.startsWith('*** Move to:')) {
        sec.moveTo = body[k]!.slice('*** Move to:'.length).trim();
        k += 1;
      }
      let chunk: Chunk | null = null;
      const bodyLines: { t: string; s: string }[] = [];
      const flush = (eof: boolean) => {
        if (!chunk) return;
        chunk.eof = eof;
        sec.chunks.push(chunk);
        chunk = null;
        bodyLines.length = 0;
      };
      const openChunk = (anchor: string | null) => {
        chunk = { anchor, eof: false, O: [], N: [] };
        bodyLines.length = 0;
      };
      const pushBody = (t: string, s: string) => {
        if (!chunk) openChunk(null);
        bodyLines.push({ t, s });
        if (t === ' ') {
          chunk!.O.push(s);
          chunk!.N.push({ text: s, ctx: chunk!.O.length - 1 });
        } else if (t === '-') chunk!.O.push(s);
        else chunk!.N.push({ text: s, ctx: -1 });
      };
      for (; k < body.length; k++) {
        const b = body[k]!;
        if (b.startsWith('@@')) {
          flush(false);
          const anchor = b.slice(2).trim();
          openChunk(anchor === '' ? null : anchor);
        } else if (b.trim() === '*** End of File') {
          if (!chunk) openChunk(null);
          flush(true);
        } else if (b[0] === ' ' || b[0] === '-' || b[0] === '+') pushBody(b[0], b.slice(1));
        else if (b === '') pushBody(' ', '');
        else throw new Exit2(`error: parse ${bodyStart + k + 1}`);
      }
      flush(false);
      // Blank lines at the section's end are not part of it: an all-empty
      // trailing context run in the last chunk goes away.
      const tail = sec.chunks[sec.chunks.length - 1];
      if (tail) {
        while (
          tail.N.length > 0 &&
          tail.O.length > 0 &&
          tail.N[tail.N.length - 1]!.ctx === tail.O.length - 1 &&
          tail.O[tail.O.length - 1] === ''
        ) {
          tail.O.pop();
          tail.N.pop();
        }
      }
      if (sec.chunks.length === 0 && sec.moveTo === null) throw new Exit2(`error: parse ${sec.line}`);
    }
  }
  if (sections.length === 0) throw new Exit2('error: parse 1');
  return sections.map((sec) => {
    const p = sec.path;
    return (tree: Tree) => {
      if (!safe(p)) throw new Fail('unsafe', p);
      if (sec.kind === 'add') {
        if (tree.get(p) !== null) throw new Fail('exists', p);
        tree.now.set(p, sec.addLines.length === 0 ? '' : sec.addLines.join('\n') + '\n');
        return;
      }
      if (sec.kind === 'del') {
        if (tree.get(p) === null) throw new Fail('missing', p);
        tree.now.set(p, null);
        return;
      }
      const before = tree.get(p);
      if (before === null) throw new Fail('missing', p);
      const target = sec.moveTo;
      if (target !== null) {
        if (!safe(target)) throw new Fail('unsafe', target);
        if (tree.get(target) !== null) throw new Fail('exists', target);
      }
      const m = toModel(before);
      let cursor = 0;
      for (const ch of sec.chunks) {
        if (ch.anchor !== null) {
          const tiers = strict ? [0] : [0, 1, 2];
          let at = -1;
          for (const tier of tiers) {
            const norm = (s: string): string => (tier === 0 ? s : tier === 1 ? trimEndWs(s) : trimWs(s));
            for (let k = cursor; k < m.lines.length; k++) {
              if (norm(m.lines[k]!) === norm(ch.anchor)) {
                at = k;
                break;
              }
            }
            if (at >= 0) break;
          }
          if (at < 0) throw new Fail('no-match', p);
          cursor = at + 1;
        }
        if (ch.O.length === 0) {
          const at = ch.eof ? m.lines.length : Math.min(cursor, m.lines.length);
          m.lines.splice(at, 0, ...ch.N.map((n) => n.text));
          cursor = at + ch.N.length;
          continue;
        }
        const found = findOccurrences(m.lines, ch.O, strict);
        if (!found) throw new Fail('no-match', p);
        const cands = found.at.filter((x) => x >= cursor && (!ch.eof || x + ch.O.length === m.lines.length));
        if (cands.length === 0) throw new Fail('no-match', p);
        const at = cands[0]!;
        spliceModel(m, at, ch.O, ch.N, found.tier);
        cursor = at + ch.N.length;
      }
      const dest = target ?? p;
      tree.now.set(dest, fromModel(m));
      if (target !== null) {
        tree.now.set(p, null);
        MOVES.push([p, target]);
      }
    };
  });
}

function run(args: string[]): { code: number; out: string[] } {
  let format: string | null = null;
  let check = false;
  let strict = false;
  const pos: string[] = [];
  let ended = false;
  for (const a of args) {
    if (!ended && a === '--') ended = true;
    else if (!ended && a.startsWith('-') && a !== '-') {
      if (a.startsWith('--format=') && format === null && FORMATS.includes(a.slice(9))) format = a.slice(9);
      else if (a === '--check' && !check) check = true;
      else if (a === '--strict' && !strict) strict = true;
      else return { code: 2, out: ['error: usage'] };
    } else pos.push(a);
  }
  if (pos.length > 1) return { code: 2, out: ['error: usage'] };
  const file = pos.length === 0 || pos[0] === '-' ? null : pos[0]!;
  let text = '';
  try {
    text = readFileSync(file ?? 0, 'utf8');
  } catch {
    if (file !== null) return { code: 2, out: ['error: no-patch'] };
  }
  const lines = patchLines(text);
  const kind = format === null || format === 'auto' ? detect(lines) : format;
  if (kind === null) return { code: 2, out: ['error: format'] };
  MOVES.length = 0;
  let edits: Edit[];
  try {
    edits =
      kind === 'json'
        ? jsonEdits(text, lines)
        : kind === 'unified'
          ? unifiedEdits(lines, strict)
          : kind === 'search-replace'
            ? searchReplaceEdits(lines, strict)
            : v4aEdits(lines, strict);
    if (edits.length === 0) throw new Exit2('error: parse 1');
  } catch (e) {
    if (e instanceof Exit2) return { code: 2, out: [e.line] };
    throw e;
  }
  const tree = new Tree();
  const fails: Fail[] = [];
  for (const edit of edits) {
    const before = new Map(tree.now);
    try {
      edit(tree);
    } catch (e) {
      if (!(e instanceof Fail)) throw e;
      tree.now.clear();
      for (const [k, v] of before) tree.now.set(k, v);
      fails.push(e);
    }
  }
  if (fails.length > 0) return { code: 1, out: [...fails.map((f) => `error: ${f.code} ${f.path}`), `failed: ${fails.length} of ${edits.length} edits`] };
  const changed = [...tree.now.keys()].filter((p) => tree.original(p) !== tree.now.get(p));
  if (!check) {
    for (const p of changed) {
      const now = tree.now.get(p)!;
      if (now === null) rmSync(p, { force: true });
      else {
        mkdirSync(dirname(p), { recursive: true });
        writeFileSync(p, now);
      }
    }
  }
  // A successful move whose old path is gone and whose new path is new
  // replaces that pair's D and A lines with one R line, sorted by <new>.
  const rows: { key: string; text: string }[] = [];
  const paired = new Set<string>();
  for (const [o, n] of MOVES) {
    if (paired.has(o) || paired.has(n)) continue;
    if (tree.original(o) !== null && tree.now.get(o) === null && tree.original(n) === null && tree.now.get(n) !== null) {
      rows.push({ key: n, text: `R ${o} -> ${n}` });
      paired.add(o);
      paired.add(n);
    }
  }
  for (const p of changed) {
    if (paired.has(p)) continue;
    const was = tree.original(p);
    const now = tree.now.get(p)!;
    rows.push({ key: p, text: `${was === null ? 'A' : now === null ? 'D' : 'M'} ${p}` });
  }
  rows.sort((a, b) => Buffer.compare(Buffer.from(a.key), Buffer.from(b.key)));
  const texts = rows.map((r) => r.text);
  return { code: 0, out: [...texts, `ok: ${texts.length} ${texts.length === 1 ? 'file' : 'files'}`] };
}


const trialEnv = process.env.MAKEFUN_ENV_URL;
if (trialEnv !== undefined && trialEnv !== '') {
  // A trial: the kit's runner reads the checks from the env and runs this file on each one, without this variable.
  const { runTrial } = await import('./runner.ts');
  await runTrial(trialEnv);
} else {
  const r = run(process.argv.slice(2));
  writeSync(1, r.out.map((l) => `${l}\n`).join(''));
  process.exitCode = r.code;
}
