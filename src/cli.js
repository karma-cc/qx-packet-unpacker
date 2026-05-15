const path = require("node:path");
const { convertCaptureDirectory } = require("./converter");

async function main() {
  const args = process.argv.slice(2);
  const sourceDir = args[0];
  const outIndex = args.indexOf("--out");
  const outputPath = outIndex >= 0 ? args[outIndex + 1] : undefined;

  if (!sourceDir) {
    console.error("用法: npm run convert -- <qx导出目录> [--out 输出文件.txt]");
    process.exit(1);
  }

  const result = await convertCaptureDirectory(sourceDir, {
    outputPath: outputPath ? path.resolve(outputPath) : undefined,
  });

  console.log(`已生成: ${result.outputPath}`);
  console.log(
    `请求 ${result.stats.requests} 条，解压响应 ${result.stats.decodedResponses} 条，JSON ${result.stats.jsonBodies} 条，二进制 ${result.stats.binaryBodies} 条。`
  );
}

main().catch((error) => {
  console.error(error.stack || error.message);
  process.exit(1);
});
