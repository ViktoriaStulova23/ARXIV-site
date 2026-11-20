export function multipartBody(files: { name?: string; filename: string; bytes: Buffer }[], fields: [string, string][] = []) {
  const boundary = 'archive-lab-test-79630';
  const chunks: Buffer[] = [];
  for (const [name, value] of fields) {
    chunks.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="${name}"\r\n\r\n${value}\r\n`));
  }
  for (const file of files) {
    chunks.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="${file.name ?? 'file'}"; filename="${file.filename}"\r\nContent-Type: application/octet-stream\r\n\r\n`), file.bytes, Buffer.from('\r\n'));
  }
  chunks.push(Buffer.from(`--${boundary}--\r\n`));
  return { payload: Buffer.concat(chunks), headers: { 'content-type': `multipart/form-data; boundary=${boundary}` } };
}
