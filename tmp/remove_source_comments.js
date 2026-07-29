const fs = require("fs");
const path = require("path");
const ts = require("typescript");

const root = path.resolve(__dirname, "..");
const sourceExtensions = new Set([".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs", ".css", ".html", ".prisma"]);
const excludedDirectories = new Set([".git", ".next", "node_modules", "tmp"]);

function sourceFiles(directory) {
  const results = [];
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      if (!excludedDirectories.has(entry.name)) results.push(...sourceFiles(path.join(directory, entry.name)));
      continue;
    }
    if (sourceExtensions.has(path.extname(entry.name))) results.push(path.join(directory, entry.name));
  }
  return results;
}

function stripTypeScriptComments(input, extension) {
  const withoutJsxComments = extension === ".tsx" || extension === ".jsx"
    ? input.replace(/\{\/\*[\s\S]*?\*\/\}/g, "")
    : input;
  const scanner = ts.createScanner(
    ts.ScriptTarget.Latest,
    false,
    extension === ".tsx" || extension === ".jsx" ? ts.LanguageVariant.JSX : ts.LanguageVariant.Standard,
    withoutJsxComments,
  );
  let output = "";
  let token;
  while ((token = scanner.scan()) !== ts.SyntaxKind.EndOfFileToken) {
    if (token !== ts.SyntaxKind.SingleLineCommentTrivia && token !== ts.SyntaxKind.MultiLineCommentTrivia) {
      output += scanner.getTokenText();
    }
  }
  return output
    .replace(/^\s*\/\/.*(?:\r?\n|$)/gm, "")
    .replace(/\/\*[\s\S]*?\*\//g, "");
}

function stripCssComments(input) {
  let output = "";
  let quote = null;
  for (let index = 0; index < input.length; index += 1) {
    const char = input[index];
    const next = input[index + 1];
    if (quote) {
      output += char;
      if (char === "\\" && index + 1 < input.length) {
        output += input[index + 1];
        index += 1;
      } else if (char === quote) {
        quote = null;
      }
      continue;
    }
    if (char === '"' || char === "'") {
      quote = char;
      output += char;
      continue;
    }
    if (char === "/" && next === "*") {
      const close = input.indexOf("*/", index + 2);
      if (close === -1) throw new Error("Unclosed CSS comment");
      index = close + 1;
      continue;
    }
    output += char;
  }
  return output;
}

function stripHtmlComments(input) {
  return input.replace(/<!--[\s\S]*?-->/g, "");
}

let changed = 0;
for (const file of sourceFiles(root)) {
  const extension = path.extname(file);
  const original = fs.readFileSync(file, "utf8");
  let cleaned = original;
  if ([".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs", ".prisma"].includes(extension)) {
    cleaned = stripTypeScriptComments(original, extension);
  } else if (extension === ".css") {
    cleaned = stripCssComments(original);
  } else if (extension === ".html") {
    cleaned = stripHtmlComments(original);
  }
  if (cleaned !== original) {
    fs.writeFileSync(file, cleaned, "utf8");
    changed += 1;
  }
}
console.log(`Removed comments from ${changed} source file(s).`);
