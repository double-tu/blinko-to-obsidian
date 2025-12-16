import { requestUrl, RequestUrlResponse } from 'obsidian';
import { BlinkoSettings } from './settings';
import { BlinkoNote } from './types';

interface NoteListParams {
	page: number;
	size: number;
	orderBy: 'desc' | 'asc';
	isRecycle: boolean;
	type: number;
}

export class BlinkoClient {
	constructor(private settings: BlinkoSettings) {}

	updateSettings(settings: BlinkoSettings) {
		this.settings = settings;
	}

	async getNotes(_since: number, page: number, size: number): Promise<BlinkoNote[]> {
		const url = this.buildUrl('/v1/note/list');
		const body: NoteListParams = {
			page,
			size,
			orderBy: 'desc',
			isRecycle: false,
			type: -1,
		};

		const response = await requestUrl({
			url,
			method: 'POST',
			headers: this.buildHeaders(true),
			body: JSON.stringify(body),
		});

		if (response.status >= 400) {
			throw new Error(`Blinko API error: ${response.status} ${response.text}`);
		}

		const payload = this.parseJson(response);
		const notes = this.extractNotes(payload);
		return notes;
	}

	async getNotesByIds(ids: number[]): Promise<BlinkoNote[]> {
		if (!ids.length) {
			return [];
		}

		const url = this.buildUrl('/v1/note/list-by-ids');
		const response = await requestUrl({
			url,
			method: 'POST',
			headers: this.buildHeaders(true),
			body: JSON.stringify({ ids }),
		});

		if (response.status >= 400) {
			throw new Error(`Blinko API error: ${response.status} ${response.text}`);
		}

		const payload = this.parseJson(response);
		return this.extractNotes(payload);
	}

	async downloadFile(path: string): Promise<ArrayBuffer> {
		const url = this.buildUrl(path, { absoluteFromOrigin: true });
		const response = await requestUrl({
			url,
			method: 'GET',
			headers: this.buildHeaders(false),
		});

		if (response.status >= 400) {
			throw new Error(`Blinko attachment download failed: ${response.status}`);
		}

		return response.arrayBuffer;
	}

	resolveUrl(path: string, options?: { absoluteFromOrigin?: boolean }): string {
		return this.buildUrl(path, options);
	}

	private buildHeaders(includeJson: boolean) {
		const headers: Record<string, string> = {
			Authorization: `Bearer ${this.settings.accessToken}`,
		};

		if (includeJson) {
			headers['Content-Type'] = 'application/json';
		}

		return headers;
	}

	private buildUrl(path: string, options?: { absoluteFromOrigin?: boolean }): string {
		const trimmed = (this.settings.serverUrl || '').trim().replace(/\/+$/, '');
		if (!trimmed) {
			throw new Error('Blinko server URL is not configured.');
		}

		const cleanPath = (path || '').trim();
		if (!cleanPath) {
			return trimmed;
		}

		if (cleanPath.startsWith('http://') || cleanPath.startsWith('https://')) {
			return cleanPath;
		}

		if (options?.absoluteFromOrigin && cleanPath.startsWith('/')) {
			return `${this.getOrigin(trimmed)}${cleanPath}`;
		}

		return `${trimmed}/${cleanPath.replace(/^\/+/, '')}`;
	}

	private getOrigin(base: string): string {
		try {
			const parsed = new URL(base);
			return parsed.origin;
		} catch {
			return base.replace(/\/+$/, '');
		}
	}

	private extractNotes(payload: any): BlinkoNote[] {
		if (!payload) {
			return [];
		}

		if (Array.isArray(payload)) {
			return payload as BlinkoNote[];
		}

		const candidates = [
			payload?.data?.list,
			payload?.data?.records,
			payload?.data,
			payload?.list,
		];

		for (const candidate of candidates) {
			if (Array.isArray(candidate)) {
				return candidate as BlinkoNote[];
			}
		}

		return [];
	}

	private parseJson(response: RequestUrlResponse): any {
		try {
			return response.json;
		} catch (error) {
			const snippet = (response.text ?? '').slice(0, 200);
			throw new Error(
				`Blinko API response is not valid JSON. Check your server URL or proxy configuration. Response snippet: ${snippet}`,
			);
		}
	}
}
