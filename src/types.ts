export interface BlinkoTag {
	id?: number;
	name: string;
	parent?: number;
	tag?: BlinkoTag;
}

export interface BlinkoAttachment {
	id: number;
	name: string;
	path: string;
	type: string;
	size: string;
}

export interface BlinkoNote {
	id: number;
	content?: string;
	type?: number;
	createdAt: string;
	updatedAt: string;
	isRecycle?: boolean;
	tags?: BlinkoTag[];
	attachments?: BlinkoAttachment[];
}
