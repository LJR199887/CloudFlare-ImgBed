// Preserve valid legacy names; reject ambiguous separators and traversal.
export function isSafeFileId(id) {
    return typeof id === 'string' && id.length > 0 && !/[\\:\u0000-\u001f\u007f]/.test(id)
        && id.split('/').every(part => part && part !== '.' && part !== '..')
        && !id.startsWith('manage@') && !id.startsWith('chunk_');
}
