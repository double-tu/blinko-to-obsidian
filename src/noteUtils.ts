export function buildBlinkoBlockId(id: number): string {
	return `blinko-note-${id}`;
}

export function isFlashType(value?: number | null): boolean {
	return value !== 1 && value !== 2;
}
