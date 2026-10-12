/**
 * The two seams AxIS reads through but does not own.
 *
 *  - RetrievalPort (Storage + RAG): uploaded files, chunked, embedded and
 *    ranked. AxIS asks for the best chunks for a query and, when a chunk is
 *    not enough, for one document's text.
 *  - ConnectorPort (Drive / OneDrive / Outlook / Gmail sync): what the
 *    counselor's connected accounts hold that has not been filed yet.
 *
 * Both are registered at boot (`registerRetrieval`, `registerConnectors`).
 * Until they are, the null implementations answer with nothing, so AxIS
 * still runs on the student record alone and says what it couldn't read.
 *
 * Contract every implementation keeps:
 *  1. Run on `request.db` (the caller's RLS client), never the service role,
 *     so a search can't return a row the counselor can't already open.
 *  2. Honour `signal`: AxIS aborts a tool that runs past its time budget.
 *  3. Return text already parsed to plain UTF-8. Parsing, OCR, chunking and
 *     embeddings are the port's job; AxIS never sees bytes.
 *  4. Set `documentId` on anything that came from the `documents` table.
 *     AxIS re-checks the per-document AI switches on that id before a chunk
 *     reaches a prompt (lib/axis/guard.ts); a chunk without one is treated
 *     as connector content.
 */
import type { FastifyRequest } from "fastify";

export type SourceKind = "upload" | "drive" | "onedrive" | "outlook" | "gmail" | "record" | "catalog";

export type RetrievedChunk = {
  /** Stable per chunk, so the same passage found twice gets one citation number. */
  chunkId: string;
  /** The `documents` row this chunk was cut from; null for mail and unfiled connector items. */
  documentId: string | null;
  /** The student the document is filed under, when it is. */
  studentId: string | null;
  title: string;
  text: string;
  /** Higher is better; only compared within one search. */
  score: number;
  source: SourceKind;
  url?: string | null;
  /** 1-based page for PDFs. */
  page?: number | null;
  updatedAt?: string | null;
};

export type SearchQuery = {
  query: string;
  /** Narrow to one student's folder; null searches everything the caller can see. */
  studentId: string | null;
  k: number;
  signal?: AbortSignal;
};

export type FullDocument = {
  documentId: string;
  title: string;
  text: string;
  source: SourceKind;
  url?: string | null;
  updatedAt?: string | null;
};

export interface RetrievalPort {
  search(request: FastifyRequest, q: SearchQuery): Promise<RetrievedChunk[]>;
  read(request: FastifyRequest, q: { documentId: string; maxChars: number; signal?: AbortSignal }): Promise<FullDocument | null>;
}

export type ConnectedProvider = "google" | "microsoft";

export interface ConnectorPort {
  /** Providers with live tokens for this counselor. Cheap: called on every turn. */
  connected(request: FastifyRequest): Promise<ConnectedProvider[]>;
  /** Mail the counselor sent or received, newest relevant first. One chunk per message. */
  searchMail(request: FastifyRequest, q: SearchQuery): Promise<RetrievedChunk[]>;
  /** Drive / OneDrive files not (yet) filed into Meridies. */
  searchFiles(request: FastifyRequest, q: SearchQuery): Promise<RetrievedChunk[]>;
}

const NULL_RETRIEVAL: RetrievalPort = {
  search: async () => [],
  read: async () => null,
};

const NULL_CONNECTORS: ConnectorPort = {
  connected: async () => [],
  searchMail: async () => [],
  searchFiles: async () => [],
};

let retrieval: RetrievalPort = NULL_RETRIEVAL;
let connectors: ConnectorPort = NULL_CONNECTORS;

export function registerRetrieval(port: RetrievalPort): void {
  retrieval = port;
}
export function registerConnectors(port: ConnectorPort): void {
  connectors = port;
}
export const getRetrieval = (): RetrievalPort => retrieval;
export const getConnectors = (): ConnectorPort => connectors;
/** True once the RAG port is registered, so the router stops promising document answers it can't give. */
export const retrievalReady = (): boolean => retrieval !== NULL_RETRIEVAL;
