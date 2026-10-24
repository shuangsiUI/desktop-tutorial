export const httpError = (status, message) => Object.assign(Error(message), { status });
export async function readJson(req, limit = 8 * 1024 * 1024) {
  if (!/^application\/json(?:;|$)/i.test(req.headers['content-type'] || ''))
    throw httpError(415, '仅支持JSON');
  if (Number(req.headers['content-length'] || 0) > limit) throw httpError(413, '请求内容过大');
  const chunks = [];
  let size = 0;
  for await (const chunk of req.iterator({ destroyOnReturn: false })) {
    size += chunk.length;
    if (size > limit) {
      req.resume();
      throw httpError(413, '请求内容过大');
    }
    chunks.push(chunk);
  }
  let value;
  try {
    value = JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    throw httpError(400, 'JSON格式错误');
  }
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw httpError(400, '请求须为对象');
  return value;
}
export function json(res, status, value) {
  res.writeHead(status, {
    'Content-Type': 'application/json;charset=utf-8',
    'Cache-Control': 'no-store'
  });
  res.end(JSON.stringify(value));
}
