// 用法：node tools/cdp.mjs <步骤文件.mjs> [参数...]
// 步骤文件默认导出 async (page, args) => 结果；结果以 JSON 打印。
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { connect } from './cdp-lib.mjs';

const [file, ...args] = process.argv.slice(2);
if (!file) {
  console.error('用法：node tools/cdp.mjs <步骤文件.mjs> [参数...]');
  process.exit(2);
}

const page = await connect();
let code = 0;
try {
  const mod = await import(pathToFileURL(path.resolve(file)).href);
  const out = await mod.default(page, args);
  if (out !== undefined) console.log(typeof out === 'string' ? out : JSON.stringify(out, null, 1));
} catch (e) {
  console.error('失败：' + (e && e.message ? e.message : e));
  code = 1;
} finally {
  page.close();
}
process.exit(code);
