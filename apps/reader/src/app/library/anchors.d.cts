import type {
  AnchorResolution,
  ReadingRange,
  SourceAnchor,
} from '@reader/storage-bridge';
import type { VerifiedContent } from './reading.cjs';

export function validRange(value: unknown): value is ReadingRange;
export function createAnchor(
  content: VerifiedContent,
  range: ReadingRange,
  createdAt?: string,
): SourceAnchor;
export function createAnchorResolver(
  content: VerifiedContent | null,
): (anchor: SourceAnchor) => AnchorResolution;
export function sourceLine(anchor: SourceAnchor): string;
