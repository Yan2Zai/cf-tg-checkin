// D1 版 Worker 构建的混淆填充脚本。
// 在明文产物前加一段死代码字符串数组（__novelJaneEyreFiller），数组由公有领域小说文本切段拼成，
// 让发出去的包更难一眼读懂。数组名故意用长名字，避免与 esbuild 压缩后产物里的短变量名冲突。
// 数组在任何地方都不被引用，只是填充，不是可执行代码。
// 文本来源：《简·爱》（Jane Eyre），夏洛蒂·勃朗特，1847 年出版，公有领域，
// Project Gutenberg #1260（https://www.gutenberg.org/files/1260/1260-8.txt）。
// 用法：node scripts/obfuscate.mjs
//   读 dist/worker-d1.mjs + build/novel.txt，写 dist/worker-d1-obf.mjs（gzip 须 ≤ 1 MiB）
import { readFileSync, writeFileSync } from "node:fs";
import { gzipSync } from "node:zlib";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const inputPath = join(root, "dist", "worker-d1.mjs");
const novelPath = join(root, "build", "novel.txt");
const outputPath = join(root, "dist", "worker-d1-obf.mjs");
const MAX_GZIP_BYTES = 1048576; // 1 MiB：Cloudflare Workers 体积上限
const CHUNK_SIZE = 4000; // 每段死代码字符串的字符数

const novel = readFileSync(novelPath, "utf8");
const chunks = [];
for (let i = 0; i < novel.length; i += CHUNK_SIZE) {
  chunks.push(JSON.stringify(novel.slice(i, i + CHUNK_SIZE)));
}

const banner =
  "// 混淆填充：下面的死代码字符串数组不被任何地方引用。\n" +
  "// 文本来源：《简·爱》，夏洛蒂·勃朗特（1847），公有领域（Project Gutenberg #1260）。\n";
const filler = `const __novelJaneEyreFiller=[${chunks.join(",")}];\n`;
const original = readFileSync(inputPath, "utf8");
const output = banner + filler + "\n" + original;

const gzipped = gzipSync(output, { level: 9 });
if (gzipped.length > MAX_GZIP_BYTES) {
  console.error(
    `混淆失败：gzip 后 ${gzipped.length} 字节，超过 ${MAX_GZIP_BYTES} 字节上限；请减小 build/novel.txt 再试。`,
  );
  process.exit(1);
}
writeFileSync(outputPath, output, "utf8");
console.log(`混淆完成：已写 ${outputPath}（gzip 后 ${gzipped.length} 字节）`);
