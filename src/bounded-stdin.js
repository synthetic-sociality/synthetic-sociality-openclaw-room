export async function readBoundedStdin(stream, {maxBytes, errorMessage}) {
  const chunks = [];
  let bytes = 0;
  for await (const chunk of stream) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    bytes += buffer.byteLength;
    if (bytes > maxBytes) throw new Error(errorMessage);
    chunks.push(buffer);
  }
  const input = Buffer.concat(chunks, bytes).toString("utf8");
  if (!input.trim()) throw new Error(errorMessage);
  return input;
}
