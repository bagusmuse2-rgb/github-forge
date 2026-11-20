// The git object model, implemented from the format itself: SHA-1 object ids, commit/tree/tag
// parsing and building, packfile reading (with ofs/ref delta resolution) and writing, and the
// graph walks the forge needs (reachability, shallow closures, ancestry). Node built-ins only:
// node:crypto for SHA-1 and node:zlib for the pack streams. No git binary exists in the trial pod.

import { createHash } from 'node:crypto';
import { deflateSync, inflateSync } from 'node:zlib';

export type GitObjectType = 'commit' | 'tree' | 'blob' | 'tag';

export interface GitObject {
  readonly type: GitObjectType;
  readonly data: Buffer;
}

export const ZERO_OID = '0'.repeat(40);

const TYPE_CODE: Readonly<Record<GitObjectType, number>> = { commit: 1, tree: 2, blob: 3, tag: 4 };
const CODE_TYPE: Readonly<Record<number, GitObjectType>> = { 1: 'commit', 2: 'tree', 3: 'blob', 4: 'tag' };

export function isObjectId(value: string): boolean {
  return /^[0-9a-f]{40}$/.test(value);
}

/** git's object id: SHA-1 over `<type> <size>\0` followed by the object's bytes. */
export function hashObject(type: GitObjectType, data: Uint8Array): string {
  const body = Buffer.isBuffer(data) ? data : Buffer.from(data.buffer, data.byteOffset, data.byteLength);
  const hash = createHash('sha1');
  hash.update(`${type} ${body.length}\u0000`, 'utf8');
  hash.update(body);
  return hash.digest('hex');
}

// ---------------------------------------------------------------------------------------------
// the store
// ---------------------------------------------------------------------------------------------

/**
 * One content-addressed object store shared by every repository. An oid is a hash of the bytes,
 * so two repos holding the same oid hold the same object; a repo only ever serves what its own
 * refs reach, so the sharing is invisible on the wire.
 */
export class ObjectStore {
  readonly objects = new Map<string, GitObject>();
  private readonly commitCache = new Map<string, CommitView>();
  private readonly treeCache = new Map<string, TreeEntry[]>();

  /** Store an object (idempotent) and answer its oid. */
  put(type: GitObjectType, data: Buffer): string {
    const oid = hashObject(type, data);
    if (!this.objects.has(oid)) this.objects.set(oid, { type, data });
    return oid;
  }

  get(oid: string): GitObject | undefined {
    return this.objects.get(oid);
  }

  has(oid: string): boolean {
    return this.objects.has(oid);
  }

  commit(oid: string): CommitView | null {
    const cached = this.commitCache.get(oid);
    if (cached) return cached;
    const object = this.objects.get(oid);
    if (!object || object.type !== 'commit') return null;
    const view = parseCommit(object.data);
    this.commitCache.set(oid, view);
    return view;
  }

  tree(oid: string): TreeEntry[] | null {
    const cached = this.treeCache.get(oid);
    if (cached) return cached;
    const object = this.objects.get(oid);
    if (!object || object.type !== 'tree') return null;
    const entries = parseTree(object.data);
    this.treeCache.set(oid, entries);
    return entries;
  }

  /** The commit a tag (chain) ultimately points at, or null. */
  peelToCommit(oid: string): string | null {
    let current = oid;
    for (let depth = 0; depth < 16; depth += 1) {
      const object = this.objects.get(current);
      if (!object) return null;
      if (object.type === 'commit') return current;
      if (object.type !== 'tag') return null;
      current = parseTag(object.data).object;
    }
    return null;
  }

  /** The object a tag (chain) points at directly (one peel), or the oid itself for non-tags. */
  peelOnce(oid: string): string {
    const object = this.objects.get(oid);
    if (object && object.type === 'tag') return parseTag(object.data).object;
    return oid;
  }
}

// ---------------------------------------------------------------------------------------------
// object parsing and building
// ---------------------------------------------------------------------------------------------

export interface TreeEntry {
  readonly mode: string;
  readonly name: string;
  readonly oid: string;
}

export interface CommitView {
  readonly tree: string;
  readonly parents: string[];
  readonly author: string;
  readonly committer: string;
  readonly message: string;
}

export interface TagView {
  readonly object: string;
  readonly type: GitObjectType;
  readonly tag: string;
  readonly tagger: string;
  readonly message: string;
}

export function parseTree(data: Uint8Array): TreeEntry[] {
  const buffer = Buffer.isBuffer(data) ? data : Buffer.from(data);
  const entries: TreeEntry[] = [];
  let offset = 0;
  while (offset < buffer.length) {
    const space = buffer.indexOf(0x20, offset);
    const nul = buffer.indexOf(0x00, space + 1);
    if (space < 0 || nul < 0 || nul + 21 > buffer.length) throw new Error('malformed tree object');
    entries.push({
      mode: buffer.subarray(offset, space).toString('ascii'),
      name: buffer.subarray(space + 1, nul).toString('utf8'),
      oid: buffer.subarray(nul + 1, nul + 21).toString('hex'),
    });
    offset = nul + 21;
  }
  return entries;
}

/** git's tree sort: byte order of the name, a directory compared as if it ended in '/'. */
function compareTreeEntries(a: TreeEntry, b: TreeEntry): number {
  const left = Buffer.from(a.mode === '40000' ? `${a.name}/` : a.name, 'utf8');
  const right = Buffer.from(b.mode === '40000' ? `${b.name}/` : b.name, 'utf8');
  return Buffer.compare(left, right);
}

export function buildTree(entries: readonly TreeEntry[]): Buffer {
  const sorted = [...entries].sort(compareTreeEntries);
  const parts: Buffer[] = [];
  for (const entry of sorted) {
    parts.push(Buffer.from(`${entry.mode} ${entry.name}\u0000`, 'utf8'));
    parts.push(Buffer.from(entry.oid, 'hex'));
  }
  return Buffer.concat(parts);
}

export function parseCommit(data: Uint8Array): CommitView {
  const buffer = Buffer.isBuffer(data) ? data : Buffer.from(data);
  const blank = buffer.indexOf('\n\n');
  const headerEnd = blank < 0 ? buffer.length : blank;
  const headerText = buffer.subarray(0, headerEnd).toString('utf8');
  const message = blank < 0 ? '' : buffer.subarray(blank + 2).toString('utf8');
  let tree = '';
  const parents: string[] = [];
  let author = '';
  let committer = '';
  for (const line of headerText.split('\n')) {
    if (!line) continue;
    const space = line.indexOf(' ');
    const key = space < 0 ? line : line.slice(0, space);
    const value = space < 0 ? '' : line.slice(space + 1);
    if (key === 'tree') tree = value;
    else if (key === 'parent') parents.push(value);
    else if (key === 'author') author = value;
    else if (key === 'committer') committer = value;
  }
  return { tree, parents, author, committer, message };
}

export function buildCommit(fields: {
  tree: string;
  parents?: readonly string[];
  message: string;
  author: string;
  committer: string;
}): Buffer {
  const lines = [`tree ${fields.tree}`];
  for (const parent of fields.parents ?? []) lines.push(`parent ${parent}`);
  lines.push(`author ${fields.author}`, `committer ${fields.committer}`, '');
  return Buffer.from(`${lines.join('\n')}\n${fields.message}`, 'utf8');
}

export function parseTag(data: Uint8Array): TagView {
  const buffer = Buffer.isBuffer(data) ? data : Buffer.from(data);
  const blank = buffer.indexOf('\n\n');
  const headerEnd = blank < 0 ? buffer.length : blank;
  const headers = new Map<string, string>();
  for (const line of buffer.subarray(0, headerEnd).toString('utf8').split('\n')) {
    if (!line) continue;
    const space = line.indexOf(' ');
    if (space >= 0) headers.set(line.slice(0, space), line.slice(space + 1));
  }
  return {
    object: headers.get('object') ?? '',
    type: (headers.get('type') ?? 'commit') as GitObjectType,
    tag: headers.get('tag') ?? '',
    tagger: headers.get('tagger') ?? '',
    message: blank < 0 ? '' : buffer.subarray(blank + 2).toString('utf8'),
  };
}

/** Split an ident line (`Name <email> ts tz`) into its parts for the REST commit view. */
export function parseIdent(ident: string): { name: string; email: string; timestamp: number; timezone: string } {
  const match = /^(.*?) <(.*?)> (\d+) ([+-]\d{4})$/.exec(ident);
  if (!match) return { name: ident, email: '', timestamp: 0, timezone: '+0000' };
  return { name: match[1], email: match[2], timestamp: Number(match[3]), timezone: match[4] };
}

// ---------------------------------------------------------------------------------------------
// graph walks
// ---------------------------------------------------------------------------------------------

/** Every object reachable from `roots` (commit -> tree + parents, tree -> entries, tag -> target). */
export function collectReachable(store: ObjectStore, roots: Iterable<string>, options: { allowMissing?: boolean } = {}): Set<string> {
  const seen = new Set<string>();
  const queue: string[] = [];
  for (const root of roots) if (isObjectId(root)) queue.push(root);
  while (queue.length) {
    const oid = queue.pop()!;
    if (seen.has(oid)) continue;
    const object = store.get(oid);
    if (!object) {
      if (options.allowMissing) continue;
      throw new Error(`object ${oid} is missing from the store`);
    }
    seen.add(oid);
    if (object.type === 'commit') {
      const commit = store.commit(oid)!;
      queue.push(commit.tree);
      for (const parent of commit.parents) queue.push(parent);
    } else if (object.type === 'tag') {
      queue.push(parseTag(object.data).object);
    } else if (object.type === 'tree') {
      for (const entry of store.tree(oid)!) {
        if (entry.mode === '160000') continue; // a gitlink names a commit this repo does not hold
        queue.push(entry.oid);
      }
    }
  }
  return seen;
}

/** The tree closure of one commit: the commit, its tree and every subtree and blob under it. */
export function treeClosure(store: ObjectStore, commitOid: string): Set<string> {
  const out = new Set<string>();
  const commit = store.commit(commitOid);
  if (!commit) return out;
  out.add(commitOid);
  const queue = [commit.tree];
  while (queue.length) {
    const oid = queue.pop()!;
    if (out.has(oid)) continue;
    const entries = store.tree(oid);
    if (!entries) continue;
    out.add(oid);
    for (const entry of entries) {
      if (entry.mode === '40000') queue.push(entry.oid);
      else if (entry.mode !== '160000') out.add(entry.oid);
    }
  }
  return out;
}

export interface ShallowClosure {
  readonly objects: Set<string>;
  /** Included commits that have at least one parent outside the set: the shallow boundary. */
  readonly boundary: string[];
}

/**
 * The objects of a depth-limited clone: commits within `depth` generations of the wants (a want
 * is generation 1), each with its full tree closure, plus any tag objects that point into the set.
 */
export function shallowClosure(store: ObjectStore, wants: readonly string[], depth: number): ShallowClosure {
  const commitDepth = new Map<string, number>();
  const tags = new Set<string>();
  let frontier: string[] = [];
  for (const want of wants) {
    // Resolve a want through tag objects to the commit it names; the tags ride along.
    let current = want;
    for (let hops = 0; hops < 16; hops += 1) {
      const object = store.get(current);
      if (!object) break;
      if (object.type === 'tag') {
        tags.add(current);
        current = parseTag(object.data).object;
        continue;
      }
      if (object.type === 'commit' && !commitDepth.has(current)) {
        commitDepth.set(current, 1);
        frontier.push(current);
      }
      break;
    }
  }
  for (let level = 1; level < depth && frontier.length; level += 1) {
    const next: string[] = [];
    for (const oid of frontier) {
      const commit = store.commit(oid);
      if (!commit) continue;
      for (const parent of commit.parents) {
        if (!commitDepth.has(parent)) {
          commitDepth.set(parent, level + 1);
          next.push(parent);
        }
      }
    }
    frontier = next;
  }
  const objects = new Set<string>(tags);
  const boundary: string[] = [];
  for (const [oid] of commitDepth) {
    for (const member of treeClosure(store, oid)) objects.add(member);
    const commit = store.commit(oid);
    if (commit && commit.parents.some((parent) => !commitDepth.has(parent))) boundary.push(oid);
  }
  return { objects, boundary };
}

/** True when `ancestor` is `descendant` itself or reachable from it through parent edges. */
export function isAncestor(store: ObjectStore, ancestor: string, descendant: string): boolean {
  if (ancestor === descendant) return true;
  const seen = new Set<string>();
  const queue = [descendant];
  while (queue.length) {
    const oid = queue.pop()!;
    if (oid === ancestor) return true;
    if (seen.has(oid)) continue;
    seen.add(oid);
    const commit = store.commit(oid);
    if (!commit) continue;
    for (const parent of commit.parents) queue.push(parent);
  }
  return false;
}

/** The set of commits reachable from `tip` (inclusive), for merge-base computation. */
export function commitAncestors(store: ObjectStore, tip: string): Set<string> {
  const seen = new Set<string>();
  const queue = [tip];
  while (queue.length) {
    const oid = queue.pop()!;
    if (seen.has(oid)) continue;
    const commit = store.commit(oid);
    if (!commit) continue;
    seen.add(oid);
    for (const parent of commit.parents) queue.push(parent);
  }
  return seen;
}

/** A merge base of two tips: a common ancestor that is not itself an ancestor of another candidate. */
export function mergeBase(store: ObjectStore, a: string, b: string): string | null {
  const ancestorsA = commitAncestors(store, a);
  const common: string[] = [];
  const seen = new Set<string>();
  const queue = [b];
  while (queue.length) {
    const oid = queue.pop()!;
    if (seen.has(oid)) continue;
    seen.add(oid);
    const commit = store.commit(oid);
    if (!commit) continue;
    if (ancestorsA.has(oid)) common.push(oid);
    for (const parent of commit.parents) queue.push(parent);
  }
  for (const candidate of common) {
    let shadowed = false;
    for (const other of common) {
      if (other !== candidate && isAncestor(store, candidate, other)) {
        shadowed = true;
        break;
      }
    }
    if (!shadowed) return candidate;
  }
  return common[0] ?? null;
}

// ---------------------------------------------------------------------------------------------
// trees as flat path maps (contents writes, diffs, merges)
// ---------------------------------------------------------------------------------------------

export interface FlatEntry {
  readonly mode: string;
  readonly oid: string;
}

/** Flatten a tree into `path -> {mode, oid}` for its blobs (and gitlinks), recursing into subtrees. */
export function flattenTree(store: ObjectStore, treeOid: string, prefix = '', out = new Map<string, FlatEntry>()): Map<string, FlatEntry> {
  const entries = store.tree(treeOid);
  if (!entries) return out;
  for (const entry of entries) {
    const path = prefix === '' ? entry.name : `${prefix}/${entry.name}`;
    if (entry.mode === '40000') flattenTree(store, entry.oid, path, out);
    else out.set(path, { mode: entry.mode, oid: entry.oid });
  }
  return out;
}

/** Rebuild nested tree objects from a flat path map; answers the root tree's oid. */
export function unflattenTree(store: ObjectStore, flat: ReadonlyMap<string, FlatEntry>): string {
  interface Dir {
    files: Map<string, FlatEntry>;
    dirs: Map<string, Dir>;
  }
  const root: Dir = { files: new Map(), dirs: new Map() };
  for (const [path, entry] of flat) {
    const segments = path.split('/');
    let dir = root;
    for (let index = 0; index < segments.length - 1; index += 1) {
      let next = dir.dirs.get(segments[index]);
      if (!next) {
        next = { files: new Map(), dirs: new Map() };
        dir.dirs.set(segments[index], next);
      }
      dir = next;
    }
    dir.files.set(segments[segments.length - 1], entry);
  }
  const build = (dir: Dir): string => {
    const entries: TreeEntry[] = [];
    for (const [name, sub] of dir.dirs) entries.push({ mode: '40000', name, oid: build(sub) });
    for (const [name, entry] of dir.files) entries.push({ mode: entry.mode, name, oid: entry.oid });
    return store.put('tree', buildTree(entries));
  };
  return build(root);
}

// ---------------------------------------------------------------------------------------------
// packfiles
// ---------------------------------------------------------------------------------------------

function readVarintSize(buffer: Buffer, start: number): { size: number; next: number; first: number } {
  let byte = buffer[start];
  const first = byte;
  let size = byte & 0x0f;
  let shift = 4;
  let offset = start + 1;
  while (byte & 0x80) {
    byte = buffer[offset++];
    size += (byte & 0x7f) * 2 ** shift;
    shift += 7;
    if (shift > 63) throw new Error('pack entry size varint is too long');
  }
  return { size, next: offset, first };
}

function readOfsDeltaBase(buffer: Buffer, start: number): { baseOffset: number; next: number } {
  let byte = buffer[start];
  let offset = start + 1;
  let value = byte & 0x7f;
  while (byte & 0x80) {
    byte = buffer[offset++];
    value = (value + 1) * 128 + (byte & 0x7f);
  }
  return { baseOffset: value, next: offset };
}

/** Inflate the zlib stream at `offset`; the info form reports how many bytes it consumed. */
function inflateAt(buffer: Buffer, offset: number): { data: Buffer; next: number } {
  const result = inflateSync(buffer.subarray(offset), { info: true }) as unknown as {
    buffer: Buffer;
    engine: { bytesWritten: number };
  };
  return { data: result.buffer, next: offset + result.engine.bytesWritten };
}

/** Apply a git delta (copy/insert instruction stream) to a base object's bytes. */
export function applyDelta(base: Uint8Array, delta: Uint8Array): Buffer {
  const baseBuffer = Buffer.isBuffer(base) ? base : Buffer.from(base);
  const deltaBuffer = Buffer.isBuffer(delta) ? delta : Buffer.from(delta);
  let offset = 0;
  const readSize = (): number => {
    let value = 0;
    let shift = 0;
    for (;;) {
      const byte = deltaBuffer[offset++];
      value += (byte & 0x7f) * 2 ** shift;
      shift += 7;
      if (!(byte & 0x80)) break;
    }
    return value;
  };
  const sourceSize = readSize();
  const targetSize = readSize();
  if (sourceSize !== baseBuffer.length) throw new Error('delta base size mismatch');
  const out = Buffer.allocUnsafe(targetSize);
  let written = 0;
  while (offset < deltaBuffer.length) {
    const op = deltaBuffer[offset++];
    if (op & 0x80) {
      let copyOffset = 0;
      let copySize = 0;
      let shift = 0;
      for (let bit = 0; bit < 4; bit += 1) {
        if (op & (1 << bit)) copyOffset += deltaBuffer[offset++] * 2 ** shift;
        shift += 8;
      }
      shift = 0;
      for (let bit = 4; bit < 7; bit += 1) {
        if (op & (1 << bit)) copySize += deltaBuffer[offset++] * 2 ** shift;
        shift += 8;
      }
      if (copySize === 0) copySize = 0x10000;
      baseBuffer.copy(out, written, copyOffset, copyOffset + copySize);
      written += copySize;
    } else if (op !== 0) {
      const literal = op & 0x7f;
      deltaBuffer.copy(out, written, offset, offset + literal);
      offset += literal;
      written += literal;
    } else {
      throw new Error('delta opcode 0 is invalid');
    }
  }
  if (written !== targetSize) throw new Error('delta produced the wrong size');
  return out;
}

/**
 * Read a packfile and resolve every object, including ofs/ref deltas (a ref-delta base may come
 * from the store via `resolveBase`). Throws on any structural problem; the caller decides what an
 * unpack failure means on its surface.
 */
export function readPack(store: ObjectStore, pack: Uint8Array, resolveBase?: (oid: string) => GitObject | undefined): Map<string, GitObject> {
  const buffer = Buffer.isBuffer(pack) ? pack : Buffer.from(pack);
  if (buffer.length < 32 || buffer.subarray(0, 4).toString('ascii') !== 'PACK') throw new Error('not a packfile');
  const version = buffer.readUInt32BE(4);
  if (version !== 2 && version !== 3) throw new Error(`unsupported pack version ${version}`);
  const declaredCount = buffer.readUInt32BE(8);
  const trailerStart = buffer.length - 20;
  const trailer = buffer.subarray(trailerStart).toString('hex');
  const computed = createHash('sha1').update(buffer.subarray(0, trailerStart)).digest('hex');
  if (trailer !== computed) throw new Error('pack checksum mismatch');

  interface RawEntry {
    offset: number;
    typeCode: number;
    data: Buffer;
    baseOffset?: number;
    baseOid?: string;
  }
  const raw: RawEntry[] = [];
  const byOffset = new Map<number, RawEntry>();
  let offset = 12;
  for (let index = 0; index < declaredCount; index += 1) {
    const entryOffset = offset;
    const header = readVarintSize(buffer, offset);
    offset = header.next;
    const typeCode = (header.first >> 4) & 0x07;
    const entry: RawEntry = { offset: entryOffset, typeCode, data: Buffer.alloc(0) };
    if (typeCode === 6) {
      const base = readOfsDeltaBase(buffer, offset);
      offset = base.next;
      entry.baseOffset = entryOffset - base.baseOffset;
    } else if (typeCode === 7) {
      entry.baseOid = buffer.subarray(offset, offset + 20).toString('hex');
      offset += 20;
    } else if (!CODE_TYPE[typeCode]) {
      throw new Error(`unknown pack type code ${typeCode}`);
    }
    const inflated = inflateAt(buffer.subarray(0, trailerStart), offset);
    if (inflated.data.length !== header.size) throw new Error('pack entry size mismatch');
    entry.data = inflated.data;
    offset = inflated.next;
    raw.push(entry);
    byOffset.set(entryOffset, entry);
  }

  const resolved = new Map<string, GitObject>();
  const resolvedByOffset = new Map<number, { type: GitObjectType; data: Buffer; oid: string }>();
  const resolvedByOid = new Map<string, { type: GitObjectType; data: Buffer; oid: string }>();
  // A plain entry's oid is computable up front, so a ref-delta can find its base before any
  // resolution happens; delta entries join the same map as they resolve.
  for (const entry of raw) {
    if (entry.typeCode !== 6 && entry.typeCode !== 7) {
      const type = CODE_TYPE[entry.typeCode];
      resolvedByOid.set(hashObject(type, entry.data), { type, data: entry.data, oid: hashObject(type, entry.data) });
    }
  }
  const resolve = (entry: RawEntry): { type: GitObjectType; data: Buffer; oid: string } => {
    const done = resolvedByOffset.get(entry.offset);
    if (done) return done;
    let type: GitObjectType;
    let data: Buffer;
    if (entry.typeCode === 6) {
      const baseEntry = byOffset.get(entry.baseOffset!);
      if (!baseEntry) throw new Error('ofs-delta base is not in the pack');
      const base = resolve(baseEntry);
      type = base.type;
      data = applyDelta(base.data, entry.data);
    } else if (entry.typeCode === 7) {
      const inPack = resolvedByOid.get(entry.baseOid!);
      if (inPack) {
        type = inPack.type;
        data = applyDelta(inPack.data, entry.data);
      } else {
        const external = resolveBase?.(entry.baseOid!) ?? store.get(entry.baseOid!);
        if (!external) throw new Error(`ref-delta base ${entry.baseOid} is unavailable`);
        type = external.type;
        data = applyDelta(external.data, entry.data);
      }
    } else {
      type = CODE_TYPE[entry.typeCode];
      data = entry.data;
    }
    const oid = hashObject(type, data);
    const value = { type, data, oid };
    resolvedByOffset.set(entry.offset, value);
    resolvedByOid.set(oid, value);
    resolved.set(oid, { type, data });
    return value;
  };
  for (const entry of raw) resolve(entry);
  return resolved;
}

function writePackObjectHeader(type: GitObjectType, size: number): Buffer {
  const code = TYPE_CODE[type];
  const bytes: number[] = [];
  let remaining = size;
  let first = (code << 4) | (remaining & 0x0f);
  remaining = Math.floor(remaining / 16);
  while (remaining > 0) {
    bytes.push(first | 0x80);
    first = remaining & 0x7f;
    remaining = Math.floor(remaining / 128);
  }
  bytes.push(first);
  return Buffer.from(bytes);
}

/** Build a packfile from plain objects (no deltas), in the caller's order. Trailer is the SHA-1. */
export function writePack(objects: Iterable<GitObject>): Buffer {
  const list = [...objects];
  const parts: Buffer[] = [];
  const header = Buffer.allocUnsafe(12);
  header.write('PACK', 0, 4, 'ascii');
  header.writeUInt32BE(2, 4);
  header.writeUInt32BE(list.length, 8);
  parts.push(header);
  for (const object of list) {
    parts.push(writePackObjectHeader(object.type, object.data.length));
    parts.push(deflateSync(object.data));
  }
  const body = Buffer.concat(parts);
  return Buffer.concat([body, createHash('sha1').update(body).digest()]);
}

/**
 * Pack the given object ids in a deterministic order: commits first (in the order given), then
 * trees, blobs and tags sorted by oid. Deterministic bytes for a deterministic request sequence.
 */
export function packObjects(store: ObjectStore, oids: Iterable<string>): Buffer {
  const commits: GitObject[] = [];
  const trees: GitObject[] = [];
  const blobs: GitObject[] = [];
  const tags: GitObject[] = [];
  const seen = new Set<string>();
  for (const oid of oids) {
    if (seen.has(oid)) continue;
    seen.add(oid);
    const object = store.get(oid);
    if (!object) continue;
    if (object.type === 'commit') commits.push(object);
    else if (object.type === 'tree') trees.push(object);
    else if (object.type === 'blob') blobs.push(object);
    else tags.push(object);
  }
  const byOid = (a: GitObject, b: GitObject): number => {
    const x = hashObject(a.type, a.data);
    const y = hashObject(b.type, b.data);
    return x < y ? -1 : x > y ? 1 : 0;
  };
  trees.sort(byOid);
  blobs.sort(byOid);
  tags.sort(byOid);
  return writePack([...tags, ...commits, ...trees, ...blobs]);
}
