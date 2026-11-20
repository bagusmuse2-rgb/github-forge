// git smart HTTP: info/refs advertisements, git-upload-pack (protocol v2 with a v0 fallback) and
// git-receive-pack (v0, report-status in side-band-64k). The wire dialect is the one real git and
// the suite's own client speak: pkt-lines, shallow-info, per-ref ng lines for refused updates.

import {
  ZERO_OID,
  collectReachable,
  isAncestor,
  isObjectId,
  packObjects,
  readPack,
  shallowClosure,
  treeClosure,
} from './gitobj.ts';
import type { Forge, Repo } from './forge.ts';

export const PKT_MAX_PAYLOAD = 65520 - 4;

export function pktLine(payload: string | Buffer): Buffer {
  const data = typeof payload === 'string' ? Buffer.from(payload, 'utf8') : payload;
  const header = Buffer.allocUnsafe(4);
  header.write((data.length + 4).toString(16).padStart(4, '0'), 0, 4, 'ascii');
  return Buffer.concat([header, data]);
}

export const PKT_FLUSH = Buffer.from('0000', 'ascii');
export const PKT_DELIM = Buffer.from('0001', 'ascii');

export type PktPacket =
  | { kind: 'data'; payload: Buffer }
  | { kind: 'flush' }
  | { kind: 'delim' }
  | { kind: 'response-end' };

/** Decode a complete pkt-line stream; throws on malformed framing. */
export function decodePktLines(bytes: Buffer): PktPacket[] {
  const packets: PktPacket[] = [];
  let offset = 0;
  while (offset < bytes.length) {
    if (offset + 4 > bytes.length) throw new Error('truncated pkt-line');
    const header = bytes.subarray(offset, offset + 4).toString('ascii');
    if (!/^[0-9a-fA-F]{4}$/.test(header)) throw new Error('invalid pkt-line length');
    const length = Number.parseInt(header, 16);
    if (length === 0) {
      packets.push({ kind: 'flush' });
      offset += 4;
    } else if (length === 1) {
      packets.push({ kind: 'delim' });
      offset += 4;
    } else if (length === 2) {
      packets.push({ kind: 'response-end' });
      offset += 4;
    } else if (length === 3 || length > 65520) {
      throw new Error('invalid pkt-line length');
    } else {
      if (offset + length > bytes.length) throw new Error('truncated pkt-line');
      packets.push({ kind: 'data', payload: bytes.subarray(offset + 4, offset + length) });
      offset += length;
    }
  }
  return packets;
}

function linesOf(packets: readonly PktPacket[]): string[] {
  const lines: string[] = [];
  for (const packet of packets) if (packet.kind === 'data') lines.push(packet.payload.toString('utf8').replace(/\n$/, ''));
  return lines;
}

/** The refs a repo advertises, in git's order: HEAD first, then sorted refs. */
function advertisedRefs(forge: Forge, repo: Repo): Array<{ name: string; oid: string }> {
  void forge;
  const refs: Array<{ name: string; oid: string }> = [];
  const names = [...repo.refs.keys()].sort();
  for (const name of names) refs.push({ name, oid: repo.refs.get(name)! });
  return refs;
}

function headTarget(repo: Repo): string {
  return `refs/heads/${repo.defaultBranch}`;
}

// ---------------------------------------------------------------------------------------------
// info/refs
// ---------------------------------------------------------------------------------------------

export interface HttpResult {
  status: number;
  contentType: string;
  body: Buffer;
}

function textResult(status: number, text: string): HttpResult {
  return { status, contentType: 'text/plain; charset=utf-8', body: Buffer.from(text, 'utf8') };
}

const UPLOAD_CAPS_V0 = 'multi_ack_detailed side-band-64k thin-pack ofs-delta shallow';
const RECEIVE_CAPS_V0 = 'report-status side-band-64k delete-refs ofs-delta quiet atomic';

export function infoRefs(forge: Forge, repo: Repo, service: string, protocolVersion: number): HttpResult {
  if (service !== 'git-upload-pack' && service !== 'git-receive-pack') {
    return textResult(400, 'invalid service\n');
  }
  const target = headTarget(repo);
  const headOid = repo.refs.get(target);
  if (service === 'git-upload-pack' && protocolVersion === 2) {
    const body = Buffer.concat([
      pktLine('version 2\n'),
      pktLine('agent=forge/1.0\n'),
      pktLine('object-format=sha1\n'),
      pktLine('fetch=shallow\n'),
      pktLine('ls-refs=unborn\n'),
      PKT_FLUSH,
    ]);
    return { status: 200, contentType: 'application/x-git-upload-pack-advertisement', body };
  }
  // v0 advertisement (receive-pack is always v0; upload-pack falls back when v2 was not asked).
  const caps = service === 'git-upload-pack' ? UPLOAD_CAPS_V0 : RECEIVE_CAPS_V0;
  const capsWithSymref = `${caps} symref=HEAD:${target} agent=forge/1.0`;
  const parts: Buffer[] = [pktLine(`# service=${service}\n`), PKT_FLUSH];
  const refs = advertisedRefs(forge, repo);
  if (refs.length === 0) {
    parts.push(pktLine(`${ZERO_OID} capabilities^{}\u0000${capsWithSymref}\n`));
  } else {
    let first = true;
    const emit = (oid: string, name: string): void => {
      if (first) {
        parts.push(pktLine(`${oid} ${name}\u0000${capsWithSymref}\n`));
        first = false;
      } else {
        parts.push(pktLine(`${oid} ${name}\n`));
      }
    };
    if (headOid !== undefined) emit(headOid, 'HEAD');
    for (const ref of refs) {
      emit(ref.oid, ref.name);
      if (ref.name.startsWith('refs/tags/')) {
        const peeled = forge.store.peelToCommit(ref.oid) ?? forge.store.peelOnce(ref.oid);
        if (peeled !== ref.oid) emit(peeled, `${ref.name}^{}`);
      }
    }
  }
  parts.push(PKT_FLUSH);
  return { status: 200, contentType: `application/x-${service}-advertisement`, body: Buffer.concat(parts) };
}

// ---------------------------------------------------------------------------------------------
// upload-pack
// ---------------------------------------------------------------------------------------------

interface FetchArgs {
  wants: string[];
  haves: string[];
  shallowLines: string[];
  depth: number | null;
}

function sidebandPackets(pack: Buffer): Buffer[] {
  const packets: Buffer[] = [];
  for (let offset = 0; offset < pack.length; offset += PKT_MAX_PAYLOAD - 1) {
    const chunk = pack.subarray(offset, Math.min(pack.length, offset + PKT_MAX_PAYLOAD - 1));
    packets.push(pktLine(Buffer.concat([Buffer.from([1]), chunk])));
  }
  if (packets.length === 0) packets.push(pktLine(Buffer.concat([Buffer.from([1]), Buffer.alloc(0)])));
  return packets;
}

/** Compute the object set for a fetch and the shallow boundary to report. */
function fetchObjects(forge: Forge, args: FetchArgs): { send: Set<string>; boundary: string[]; unshallow: string[] } {
  const excluded = new Set<string>();
  // A have that is also declared as a shallow boundary is held shallowly: the client has the
  // commit and its trees, not its ancestors, so its exclusion stops at the boundary.
  const shallowSet = new Set(args.shallowLines);
  for (const have of args.haves) {
    if (shallowSet.has(have)) continue;
    for (const oid of collectReachable(forge.store, [have], { allowMissing: true })) excluded.add(oid);
  }
  // Objects the client already holds at its shallow boundary: the boundary commits and their trees.
  for (const oid of args.shallowLines) {
    for (const member of treeClosure(forge.store, oid)) excluded.add(member);
  }
  let included: Set<string>;
  let boundary: string[] = [];
  if (args.depth !== null) {
    const closure = shallowClosure(forge.store, args.wants, args.depth);
    included = closure.objects;
    boundary = closure.boundary;
  } else {
    included = collectReachable(forge.store, args.wants, { allowMissing: true });
  }
  const send = new Set<string>();
  for (const oid of included) if (!excluded.has(oid)) send.add(oid);
  const boundarySet = new Set(boundary);
  const unshallow = args.shallowLines.filter((oid) => !boundarySet.has(oid));
  return { send, boundary, unshallow };
}

function fetchResponse(forge: Forge, args: FetchArgs, v2: boolean): HttpResult {
  const { send, boundary, unshallow } = fetchObjects(forge, args);
  const pack = packObjects(forge.store, send);
  const parts: Buffer[] = [];
  const common = args.haves.filter((oid) => forge.store.has(oid));
  if (v2) {
    parts.push(pktLine('acknowledgments\n'));
    if (common.length) {
      for (const oid of common) parts.push(pktLine(`ACK ${oid}\n`));
    } else {
      parts.push(pktLine('NAK\n'));
    }
    parts.push(PKT_FLUSH);
    if (args.depth !== null || args.shallowLines.length) {
      parts.push(pktLine('shallow-info\n'));
      for (const oid of boundary) parts.push(pktLine(`shallow ${oid}\n`));
      for (const oid of unshallow) parts.push(pktLine(`unshallow ${oid}\n`));
      parts.push(PKT_FLUSH);
    }
    parts.push(pktLine('packfile\n'));
    parts.push(...sidebandPackets(pack));
    parts.push(PKT_FLUSH);
  } else {
    if (common.length) parts.push(pktLine(`ACK ${common[common.length - 1]}\n`));
    else parts.push(pktLine('NAK\n'));
    for (const oid of boundary) parts.push(pktLine(`shallow ${oid}\n`));
    for (const oid of unshallow) parts.push(pktLine(`unshallow ${oid}\n`));
    parts.push(...sidebandPackets(pack));
    parts.push(PKT_FLUSH);
  }
  return { status: 200, contentType: 'application/x-git-upload-pack-result', body: Buffer.concat(parts) };
}

function lsRefsResponse(forge: Forge, repo: Repo, args: string[]): HttpResult {
  const peel = args.includes('peel');
  const symrefs = args.includes('symrefs');
  const unborn = args.includes('unborn');
  const prefixes = args.filter((line) => line.startsWith('ref-prefix ')).map((line) => line.slice('ref-prefix '.length));
  const keep = (name: string): boolean => prefixes.length === 0 || prefixes.some((prefix) => name.startsWith(prefix));
  const parts: Buffer[] = [];
  const target = headTarget(repo);
  const headOid = repo.refs.get(target);
  if (keep('HEAD')) {
    if (headOid !== undefined) {
      parts.push(pktLine(`${headOid} HEAD${symrefs ? ` symref-target:${target}` : ''}\n`));
    } else if (unborn) {
      parts.push(pktLine(`unborn HEAD${symrefs ? ` symref-target:${target}` : ''}\n`));
    }
  }
  for (const ref of advertisedRefs(forge, repo)) {
    if (!keep(ref.name)) continue;
    let line = `${ref.oid} ${ref.name}`;
    if (peel && ref.name.startsWith('refs/tags/')) {
      const peeled = forge.store.peelToCommit(ref.oid);
      if (peeled && peeled !== ref.oid) line += ` peeled:${peeled}`;
    }
    parts.push(pktLine(`${line}\n`));
  }
  parts.push(PKT_FLUSH);
  return { status: 200, contentType: 'application/x-git-upload-pack-result', body: Buffer.concat(parts) };
}

export function uploadPack(forge: Forge, repo: Repo, body: Buffer): HttpResult {
  let packets: PktPacket[];
  try {
    packets = decodePktLines(body);
  } catch {
    return textResult(400, 'malformed pkt-line stream\n');
  }
  const firstData = packets.find((packet) => packet.kind === 'data');
  const firstLine = firstData?.kind === 'data' ? firstData.payload.toString('utf8').replace(/\n$/, '') : '';
  if (firstLine.startsWith('command=')) {
    // Protocol v2: command + capability lines, a delim, argument lines, a flush.
    const command = firstLine.slice('command='.length);
    const delimIndex = packets.findIndex((packet) => packet.kind === 'delim');
    const argPackets = delimIndex >= 0 ? packets.slice(delimIndex + 1) : packets.slice(1);
    const args = linesOf(argPackets);
    if (command === 'ls-refs') return lsRefsResponse(forge, repo, args);
    if (command === 'fetch') {
      const fetchArgs: FetchArgs = { wants: [], haves: [], shallowLines: [], depth: null };
      for (const line of args) {
        if (line.startsWith('want ')) fetchArgs.wants.push(line.slice(5).trim());
        else if (line.startsWith('have ')) fetchArgs.haves.push(line.slice(5).trim());
        else if (line.startsWith('shallow ')) fetchArgs.shallowLines.push(line.slice(8).trim());
        else if (line.startsWith('deepen ')) fetchArgs.depth = Number.parseInt(line.slice(7), 10);
      }
      for (const want of fetchArgs.wants) {
        if (!isObjectId(want) || !forge.store.has(want)) return textResult(422, `want ${want} is not an object here\n`);
      }
      return fetchResponse(forge, fetchArgs, true);
    }
    return {
      status: 200,
      contentType: 'application/x-git-upload-pack-result',
      body: Buffer.concat([pktLine(`ERR unknown command ${command}\n`), PKT_FLUSH]),
    };
  }
  // Protocol v0: want lines, a flush, have/done lines, a flush.
  const lines = linesOf(packets);
  const fetchArgs: FetchArgs = { wants: [], haves: [], shallowLines: [], depth: null };
  for (const raw of lines) {
    const line = raw.split(' ')[0] === 'want' ? raw : raw;
    if (line.startsWith('want ')) fetchArgs.wants.push(line.slice(5, 45));
    else if (line.startsWith('have ')) fetchArgs.haves.push(line.slice(5, 45));
    else if (line.startsWith('shallow ')) fetchArgs.shallowLines.push(line.slice(8, 48));
    else if (line.startsWith('deepen ')) fetchArgs.depth = Number.parseInt(line.slice(7), 10);
  }
  fetchArgs.wants = fetchArgs.wants.map((oid) => oid.trim());
  for (const want of fetchArgs.wants) {
    if (!isObjectId(want) || !forge.store.has(want)) return textResult(422, `want ${want} is not an object here\n`);
  }
  return fetchResponse(forge, fetchArgs, false);
}

// ---------------------------------------------------------------------------------------------
// receive-pack
// ---------------------------------------------------------------------------------------------

interface PushCommand {
  oldOid: string;
  newOid: string;
  ref: string;
}

export function receivePack(forge: Forge, repo: Repo, body: Buffer): HttpResult {
  // The command list is pkt-lines up to the first flush; everything after it is the packfile.
  let headerEnd = -1;
  const commands: PushCommand[] = [];
  let capabilities = '';
  try {
    let offset = 0;
    let index = 0;
    while (offset < body.length) {
      if (offset + 4 > body.length) throw new Error('truncated');
      const header = body.subarray(offset, offset + 4).toString('ascii');
      if (!/^[0-9a-fA-F]{4}$/.test(header)) throw new Error('bad pkt-line');
      const length = Number.parseInt(header, 16);
      if (length === 0) {
        headerEnd = offset + 4;
        break;
      }
      if (length < 4 || offset + length > body.length) throw new Error('bad pkt-line');
      let line = body.subarray(offset + 4, offset + length).toString('utf8').replace(/\n$/, '');
      if (index === 0) {
        const nul = line.indexOf('\u0000');
        if (nul >= 0) {
          capabilities = line.slice(nul + 1);
          line = line.slice(0, nul);
        }
      }
      const parts = line.split(' ');
      if (parts.length === 3) commands.push({ oldOid: parts[0], newOid: parts[1], ref: parts[2] });
      offset += length;
      index += 1;
    }
  } catch {
    return textResult(400, 'malformed receive-pack request\n');
  }
  if (headerEnd < 0) return textResult(400, 'unterminated command list\n');
  const packBytes = body.subarray(headerEnd);

  let unpackLine = 'unpack ok';
  if (packBytes.length > 0) {
    try {
      const objects = readPack(forge.store, packBytes);
      for (const [oid, object] of objects) {
        if (!forge.store.objects.has(oid)) forge.store.objects.set(oid, object);
      }
    } catch (err) {
      unpackLine = `unpack ${err instanceof Error ? err.message : 'corrupt pack'}`;
    }
  }

  const reportLines: string[] = [unpackLine];
  const unpackOk = unpackLine === 'unpack ok';
  for (const command of commands) {
    if (!unpackOk) {
      reportLines.push(`ng ${command.ref} unpack failed`);
      continue;
    }
    reportLines.push(applyPushCommand(forge, repo, command));
  }

  const inner = Buffer.concat([...reportLines.map((line) => pktLine(`${line}\n`)), PKT_FLUSH]);
  const wantsSideband = capabilities.split(' ').includes('side-band-64k');
  let responseBody: Buffer;
  if (wantsSideband) {
    const packets: Buffer[] = [];
    for (let offset = 0; offset < inner.length; offset += PKT_MAX_PAYLOAD - 1) {
      const chunk = inner.subarray(offset, Math.min(inner.length, offset + PKT_MAX_PAYLOAD - 1));
      packets.push(pktLine(Buffer.concat([Buffer.from([1]), chunk])));
    }
    packets.push(PKT_FLUSH);
    responseBody = Buffer.concat(packets);
  } else {
    responseBody = inner;
  }
  return { status: 200, contentType: 'application/x-git-receive-pack-result', body: responseBody };
}

/** Validate and apply one ref update; answers its report-status line. */
function applyPushCommand(forge: Forge, repo: Repo, command: PushCommand): string {
  const { oldOid, newOid, ref } = command;
  const current = repo.refs.get(ref);
  if (newOid === ZERO_OID) {
    // Delete.
    if (current === undefined) return `ng ${ref} reference not found`;
    if (current !== oldOid) return `ng ${ref} stale info`;
    repo.refs.delete(ref);
    return `ok ${ref}`;
  }
  const newObject = forge.store.get(newOid);
  if (!newObject) return `ng ${ref} bad object`;
  if (ref.startsWith('refs/heads/') && newObject.type !== 'commit') return `ng ${ref} bad object`;
  if (oldOid === ZERO_OID) {
    // Create.
    if (current !== undefined) return current === newOid ? `ok ${ref}` : `ng ${ref} reference already exists`;
    repo.refs.set(ref, newOid);
    return `ok ${ref}`;
  }
  if (current !== oldOid) return `ng ${ref} stale info`;
  if (ref.startsWith('refs/heads/')) {
    if (!isAncestor(forge.store, oldOid, newOid)) return `ng ${ref} non-fast-forward`;
  }
  repo.refs.set(ref, newOid);
  return `ok ${ref}`;
}
