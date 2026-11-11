// Telegram and Discord multipart objects live in individual provider messages.
// The database value is their only map; it is not optional backup data.
export function needsChunkManifest(metadata) {
    return Boolean(metadata?.IsChunked) && ['TelegramNew', 'Discord'].includes(metadata.Channel);
}

export function parseChunkManifest(value, metadata) {
    const invalid = () => new Error('Invalid or incomplete chunk manifest');
    if (typeof value !== 'string') throw invalid();
    let chunks;
    try { chunks = JSON.parse(value); } catch { throw invalid(); }
    if (!Array.isArray(chunks) || !chunks.length ||
        (metadata.TotalChunks != null && metadata.TotalChunks !== chunks.length)) throw invalid();
    const indices = new Set();
    let bytes = 0;
    for (const chunk of chunks) {
        const discord = metadata.Channel === 'Discord';
        const id = discord ? chunk?.messageId : chunk?.fileId;
        if (!Number.isSafeInteger(chunk?.index) || chunk.index < 0 || chunk.index >= chunks.length ||
            indices.has(chunk.index) || typeof id !== 'string' || !id.trim() ||
            (discord && !/^\d+$/.test(id)) || !Number.isSafeInteger(chunk.size) || chunk.size < 0) throw invalid();
        indices.add(chunk.index);
        bytes += chunk.size;
    }
    if (!Number.isSafeInteger(bytes) || (metadata.FileSizeBytes != null && metadata.FileSizeBytes !== bytes)) throw invalid();
    return chunks;
}
