/**
 * release.ts: reading GitHub Releases, and fetching what they publish.
 *
 * There is a certain obligation here. A tool whose entire job is "the things on this machine have
 * fallen behind" cannot be the thing on this machine that has fallen behind.
 *
 * WHY NOT electron-updater. It is the obvious choice and it was the wrong one for this app:
 *
 *  - It cannot update a portable build at all. Half of what ships here is a single self-extracting
 *    exe, and electron-updater's Windows path assumes an NSIS install it can replace on quit. That
 *    half would have been left with no update path whatsoever.
 *  - Its integrity story is code-signing. These builds are unsigned, so the check it performs is the
 *    one check that cannot apply, and what remains is an unverified download either way.
 *  - It wants a `latest.yml` published alongside the artifacts, which means the release process has to
 *    remember to generate one. A release that forgets it is a release nobody can update to, silently.
 *
 * So this reads the GitHub Releases API directly, the same endpoint a person would open in a browser
 *, compares versions with the same comparator the package table uses, and verifies the download
 * against the `SHA256SUMS` file published in the release.
 *
 * BE CLEAR ABOUT WHAT THAT VERIFICATION IS WORTH. The checksums come from the same release as the
 * binary, so they prove the bytes arrived intact; they prove nothing about whether the release itself
 * is honest. That is what code signing is for, and these builds do not have it. A truncated or
 * corrupted download is the failure this actually prevents, and it is also the common one.
 */

import { createHash } from 'node:crypto';
import { createWriteStream } from 'node:fs';
import { mkdir, readdir, rm, stat, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import { pipeline } from 'node:stream/promises';
import { Readable } from 'node:stream';
import type { ReleaseInfo, UpdateChannel } from '../shared/types.js';
import { SOURCE_URL } from '../shared/brand.js';
import { compareVersions } from './text.js';

/** `https://github.com/<owner>/<repo>` → `<owner>/<repo>`. */
const REPO = SOURCE_URL.replace(/^https:\/\/github\.com\//, '');

const API = `https://api.github.com/repos/${REPO}/releases/latest`;

/**
 * Every request identifies itself. GitHub rejects an unidentified client, and an operator reading
 * their own traffic should be able to tell what is asking.
 */
function headers(version: string): Record<string, string> {
  return {
    Accept: 'application/vnd.github+json',
    'X-GitHub-Api-Version': '2022-11-28',
    'User-Agent': `DontLeaveUpdatesToFate/${version} (+${SOURCE_URL})`,
  };
}

interface GithubAsset {
  name?: unknown;
  size?: unknown;
  browser_download_url?: unknown;
}

interface GithubRelease {
  tag_name?: unknown;
  name?: unknown;
  html_url?: unknown;
  published_at?: unknown;
  draft?: unknown;
  prerelease?: unknown;
  body?: unknown;
  assets?: unknown;
}

export interface Asset {
  name: string;
  size: number;
  url: string;
}

export interface Release {
  version: string;
  name: string;
  notesUrl: string;
  publishedAt: string | null;
  assets: Asset[];
}

export class UpdateError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'UpdateError';
  }
}

/** `v1.2.0` and `1.2.0` both mean 1.2.0. */
export function versionFromTag(tag: string): string {
  return tag.trim().replace(/^v/i, '');
}

/**
 * Which artifact this build should be offered.
 *
 * A portable copy must be offered the portable exe and an installed copy the setup exe, handing an
 * installed user a portable exe produces a second, unmanaged copy of the app, and handing a portable
 * user an installer silently converts their "installs nothing" choice into an install.
 *
 * A `dev` run gets nothing. It has no artifact of its own and `install()` would refuse anyway, so
 * offering it one only produces a Download button that leads somewhere it cannot go.
 */
export function assetFor(assets: readonly Asset[], channel: UpdateChannel): Asset | null {
  if (channel === 'dev') return null;
  const suffix = channel === 'portable' ? '-portable.exe' : '-setup.exe';
  return assets.find((a) => a.name.toLowerCase().endsWith(suffix)) ?? null;
}

/** The published checksums file, if the release has one. */
export function checksumsIn(assets: readonly Asset[]): Asset | null {
  return assets.find((a) => /^sha256sums/i.test(a.name) && a.name.toLowerCase().endsWith('.txt')) ?? null;
}

/**
 * Pull one filename's digest out of a `sha256sum`-format file.
 *
 * The format is `<64 hex>  <filename>` per line. Matching on the filename rather than taking the
 * first line means a release with several artifacts cannot verify one binary against another's hash.
 */
export function digestFor(checksums: string, fileName: string): string | null {
  const wanted = fileName.toLowerCase();
  for (const line of checksums.split('\n')) {
    const match = /^([0-9a-f]{64})\s+\*?(.+?)\s*$/i.exec(line.trim());
    if (!match) continue;
    if (match[2]!.toLowerCase() === wanted) return match[1]!.toLowerCase();
  }
  return null;
}

/** Turn the API payload into our shape, rejecting anything malformed rather than half-trusting it. */
export function parseRelease(payload: unknown): Release | null {
  if (!payload || typeof payload !== 'object') return null;
  const raw = payload as GithubRelease;

  // The `/latest` endpoint already excludes both, but a future switch to `/releases` must not
  // silently start offering drafts.
  if (raw.draft === true || raw.prerelease === true) return null;

  const tag = typeof raw.tag_name === 'string' ? raw.tag_name : '';
  const version = versionFromTag(tag);
  if (!/^\d+(\.\d+)*/.test(version)) return null;

  const assets: Asset[] = [];
  if (Array.isArray(raw.assets)) {
    for (const entry of raw.assets as GithubAsset[]) {
      if (!entry || typeof entry !== 'object') continue;
      const name = typeof entry.name === 'string' ? entry.name : '';
      const url = typeof entry.browser_download_url === 'string' ? entry.browser_download_url : '';
      // Only ever follow a URL on GitHub's own release host.
      if (!name || !/^https:\/\/github\.com\//.test(url)) continue;
      assets.push({ name, size: typeof entry.size === 'number' ? entry.size : 0, url });
    }
  }

  return {
    version,
    name: typeof raw.name === 'string' && raw.name.trim() ? raw.name.trim() : `Version ${version}`,
    notesUrl:
      typeof raw.html_url === 'string' && raw.html_url.startsWith('https://github.com/')
        ? raw.html_url
        : `${SOURCE_URL}/releases`,
    publishedAt: typeof raw.published_at === 'string' ? raw.published_at : null,
    assets,
  };
}

/** Public shape handed to the renderer. */
export function describe(release: Release, channel: UpdateChannel): ReleaseInfo {
  const asset = assetFor(release.assets, channel);
  return {
    version: release.version,
    name: release.name,
    notesUrl: release.notesUrl,
    publishedAt: release.publishedAt,
    assetName: asset?.name ?? null,
    assetSize: asset?.size ?? null,
  };
}

/** Is `latest` actually newer than what is running? */
export function isNewer(current: string, latest: string): boolean {
  const cmp = compareVersions(current, latest);
  // An uncomparable pair means something is wrong with one of the strings. Do not nag on a guess.
  return cmp !== null && cmp < 0;
}

async function getJson(url: string, version: string, signal: AbortSignal, timeoutMs: number): Promise<unknown> {
  const response = await fetchWithTimeout(url, { headers: headers(version), signal }, timeoutMs);

  if (response.status === 404) {
    throw new UpdateError('No published release was found for this project yet.');
  }
  if (response.status === 403 || response.status === 429) {
    // Unauthenticated callers get 60 requests an hour per address; a shared address can exhaust it.
    const reset = Number(response.headers.get('x-ratelimit-reset') ?? '0');
    const minutes = reset > 0 ? Math.max(1, Math.ceil((reset * 1000 - Date.now()) / 60_000)) : null;
    throw new UpdateError(
      minutes === null
        ? 'GitHub is rate-limiting this address. Try again later.'
        : `GitHub is rate-limiting this address. Try again in about ${minutes} minute(s).`,
    );
  }
  if (!response.ok) {
    throw new UpdateError(`GitHub answered ${response.status} ${response.statusText}.`);
  }
  return response.json();
}

/**
 * `fetch` honours an AbortSignal but has no timeout of its own, and a connection that opens and then
 * stalls would hang the check forever.
 */
async function fetchWithTimeout(
  url: string,
  init: RequestInit,
  timeoutMs: number,
): Promise<Response> {
  const timer = new AbortController();
  const onAbort = (): void => timer.abort();
  const external = init.signal as AbortSignal | undefined;
  external?.addEventListener('abort', onAbort, { once: true });
  const handle = setTimeout(() => timer.abort(), timeoutMs);

  try {
    return await fetch(url, { ...init, signal: timer.signal, redirect: 'follow' });
  } catch (error) {
    if (external?.aborted) throw new UpdateError('Cancelled.');
    if (timer.signal.aborted) throw new UpdateError(`No answer within ${Math.round(timeoutMs / 1000)}s.`);
    throw new UpdateError(describeNetworkError(error));
  } finally {
    clearTimeout(handle);
    external?.removeEventListener('abort', onAbort);
  }
}

function describeNetworkError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  if (/ENOTFOUND|EAI_AGAIN|getaddrinfo/i.test(message)) return 'No network connection.';
  if (/ECONNREFUSED|ECONNRESET|EPIPE/i.test(message)) return 'The connection was refused or dropped.';
  if (/certificate|TLS|SSL/i.test(message)) return `The TLS connection failed: ${message}`;
  return `Could not reach GitHub: ${message}`;
}

/** Ask GitHub what the latest release is. */
export async function fetchLatestRelease(
  currentVersion: string,
  signal: AbortSignal,
  timeoutMs = 20_000,
): Promise<Release> {
  const payload = await getJson(API, currentVersion, signal, timeoutMs);
  const release = parseRelease(payload);
  if (!release) throw new UpdateError('GitHub returned a release this app could not read.');
  return release;
}

/** Fetch and parse the release's checksums file. Returns null when the release has none. */
export async function fetchDigest(
  release: Release,
  asset: Asset,
  currentVersion: string,
  signal: AbortSignal,
  timeoutMs = 20_000,
): Promise<string | null> {
  const sums = checksumsIn(release.assets);
  if (!sums) return null;

  const response = await fetchWithTimeout(sums.url, { headers: headers(currentVersion), signal }, timeoutMs);
  if (!response.ok) return null;
  return digestFor(await response.text(), asset.name);
}

export interface DownloadResult {
  path: string;
  /** The digest that was checked, or null when the release published none to check against. */
  verifiedAgainst: string | null;
}

/**
 * Stream an asset to disk, hashing as it goes.
 *
 * Hashed during the download rather than by re-reading afterwards: the file is a hundred megabytes,
 * and reading it twice to learn something the first pass already knew is a second of disk for nothing.
 * A mismatch deletes the file: a half-verified installer left on disk is a trap for later.
 */
export async function downloadAsset(
  asset: Asset,
  expectedDigest: string | null,
  directory: string,
  currentVersion: string,
  signal: AbortSignal,
  onProgress: (received: number, total: number) => void,
  timeoutMs = 30_000,
): Promise<DownloadResult> {
  await mkdir(directory, { recursive: true });
  const target = join(directory, asset.name);

  // A previous attempt may have left a partial file behind.
  await rm(target, { force: true });

  const response = await fetchWithTimeout(asset.url, { headers: headers(currentVersion), signal }, timeoutMs);
  if (!response.ok || !response.body) {
    throw new UpdateError(`The download failed: GitHub answered ${response.status}.`);
  }

  const total = Number(response.headers.get('content-length') ?? asset.size) || asset.size;
  const hash = createHash('sha256');
  let received = 0;

  const source = Readable.fromWeb(response.body as Parameters<typeof Readable.fromWeb>[0]);
  source.on('data', (chunk: Buffer) => {
    hash.update(chunk);
    received += chunk.length;
    onProgress(received, total);
  });

  try {
    await pipeline(source, createWriteStream(target), { signal });
  } catch (error) {
    await rm(target, { force: true });
    if (signal.aborted) throw new UpdateError('Cancelled.');
    throw new UpdateError(`The download failed: ${error instanceof Error ? error.message : String(error)}`);
  }

  const actual = hash.digest('hex');

  if (expectedDigest && actual !== expectedDigest) {
    await rm(target, { force: true });
    throw new UpdateError(
      'The download did not match the checksum published with the release. Nothing was kept.',
    );
  }

  // Size is the only cross-check left when a release publishes no checksums.
  if (!expectedDigest && asset.size > 0) {
    const written = await stat(target).catch(() => null);
    if (written && written.size !== asset.size) {
      await rm(target, { force: true });
      throw new UpdateError('The download was the wrong size and has been discarded.');
    }
  }

  return { path: target, verifiedAgainst: expectedDigest };
}

/**
 * Files this app could have put in the download directory.
 *
 * Deliberately strict, and the strictness is load-bearing. Downloads land in the user's Downloads
 * folder, because a hardened Windows install will refuse to EXECUTE anything from `%APPDATA%`, which
 * is where they used to go, and a cleanup routine let loose in someone's Downloads folder is a
 * catastrophe, not a bug. Nothing is deleted unless its name is one this app writes.
 */
const OURS = /^DontLeaveUpdatesToFate-\d[\d.]*-(?:setup|portable)\.exe$/i;

/**
 * Remove installers left in the download directory by an earlier session.
 *
 * A hundred megabytes per abandoned attempt adds up, and a stale installer for a version that has
 * since been superseded is only ever a way to install the wrong thing by accident.
 */
export async function pruneDownloads(directory: string, keep: string | null = null): Promise<void> {
  try {
    for (const name of await readdir(directory)) {
      if (keep && name === keep) continue;
      if (!OURS.test(name)) continue;
      await unlink(join(directory, name)).catch(() => undefined);
    }
  } catch {
    /* no directory yet */
  }
}

/** Exported so a test can prove the pattern never matches something that is not ours. */
export const __test = { OURS };
