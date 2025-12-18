import { App, CachedMetadata, FrontMatterCache, TFile } from 'obsidian';

export interface BlinkoFrontmatterInfo {
	id: number | null;
	source: string | null;
}

export function getCachedBlinkoFrontmatter(app: App, file: TFile): BlinkoFrontmatterInfo | null {
	const cache = app.metadataCache.getFileCache(file);
	return extractFromCache(cache);
}

export async function resolveBlinkoFrontmatter(app: App, file: TFile): Promise<BlinkoFrontmatterInfo | null> {
	const cached = getCachedBlinkoFrontmatter(app, file);
	if (cached?.id !== null && cached?.source) {
		return cached;
	}

	try {
		const content = await app.vault.cachedRead(file);
		const parsed = extractFromContent(content);
		if (parsed) {
			return {
				id: parsed.id ?? cached?.id ?? null,
				source: parsed.source ?? cached?.source ?? null,
			};
		}
	} catch {
		// Ignore read failures and fall through to cached value
	}

	return cached;
}

export function isBlinkoSourceValue(source?: string | null): boolean {
	if (!source) {
		return false;
	}
	return source.trim().toLowerCase() === 'blinko';
}

function extractFromCache(cache?: CachedMetadata | null): BlinkoFrontmatterInfo | null {
	const frontmatter = cache?.frontmatter;
	if (!frontmatter) {
		return null;
	}

	const idValue = parseNumeric(frontmatter.id ?? frontmatter.blinkoId);
	const sourceValue = parseString(frontmatter.source);
	if (idValue === null && !sourceValue) {
		return null;
	}

	return {
		id: idValue,
		source: sourceValue,
	};
}

function extractFromContent(content: string): BlinkoFrontmatterInfo | null {
	const blockMatch = content.match(/^---\s*[\r\n]+([\s\S]*?)\n---/);
	if (!blockMatch) {
		return null;
	}

	const block = blockMatch[1];
	const idValue = parseNumeric(extractLineValue(block, 'id'));
	const sourceValue = parseString(extractLineValue(block, 'source'));
	if (idValue === null && !sourceValue) {
		return null;
	}

	return {
		id: idValue,
		source: sourceValue,
	};
}

function extractLineValue(block: string, key: string): string | null {
	const regex = new RegExp(`^\\s*${key}\\s*:\\s*(.+)$`, 'mi');
	const match = regex.exec(block);
	if (!match) {
		return null;
	}

	return match[1]?.trim() ?? null;
}

function parseNumeric(value: unknown): number | null {
	if (typeof value === 'number' && Number.isFinite(value)) {
		return value;
	}
	if (typeof value === 'string') {
		const normalized = value.trim();
		if (!normalized.length) {
			return null;
		}
		const parsed = Number(normalized.replace(/^['"]|['"]$/g, ''));
		return Number.isFinite(parsed) ? parsed : null;
	}

	return null;
}

function parseString(value: unknown): string | null {
	if (typeof value === 'string') {
		const normalized = value.trim().replace(/^['"]|['"]$/g, '');
		return normalized.length ? normalized : null;
	}

	return null;
}
