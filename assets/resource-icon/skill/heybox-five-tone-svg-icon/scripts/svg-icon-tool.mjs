#!/usr/bin/env node

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";

const CANVAS_SIZE = 154;
const DEFAULT_LAYOUT = { centerX: 77, centerY: 76.5, footprint: 122 };
const DEFAULT_COMPLEXITY = { edgeDensity: 32, tolerance: 6.5 };
const CENTER_TOLERANCE = 3;
const FOOTPRINT_TOLERANCE = 8;

const TOKENS = [
  ["icon-outline", "#593408", "outline"],
  ["icon-dark", "#EC7424", "dark"],
  ["icon-gray", "#FFA53D", "gray"],
  ["icon-light", "#FFBF75", "light"],
  ["icon-white", "#FFFFFF", "white"],
];

const DISALLOWED_TAGS = [
  "script", "foreignObject", "image", "iframe", "object", "embed",
  "audio", "video", "canvas", "text", "linearGradient", "radialGradient",
  "pattern", "filter", "animate", "animateTransform", "set",
];

function usage(exitCode = 0) {
  console.log(`Usage:
  node svg-icon-tool.mjs inspect <input.svg> [--json]
  node svg-icon-tool.mjs audit <output.svg> [--json]
  node svg-icon-tool.mjs layout <output.svg> [--reference <svg-or-directory>]... [--json]
  node svg-icon-tool.mjs complexity <output.svg> [--reference <svg-or-directory>]... [--json]
  node svg-icon-tool.mjs materialize <input.svg> --out <output.svg> [--force]
  node svg-icon-tool.mjs recolor <input.svg> --out <output.svg> \\
    --outline <#RRGGBB> --dark <#RRGGBB> --gray <#RRGGBB> \\
    --light <#RRGGBB> --white <#RRGGBB> [--force]`);
  process.exit(exitCode);
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function readSvg(file) {
  if (!file || path.extname(file).toLowerCase() !== ".svg") {
    throw new Error("Input must be a .svg file.");
  }
  const stat = fs.statSync(file);
  if (!stat.isFile()) throw new Error("Input is not a regular file.");
  if (stat.size > 10 * 1024 * 1024) throw new Error("SVG exceeds the 10 MB inspection limit.");
  const text = fs.readFileSync(file, "utf8");
  if (!/<svg\b/i.test(text)) throw new Error("File does not contain an <svg> root.");
  return text;
}

function attrValue(attrs, name) {
  const match = attrs.match(new RegExp(`\\b${escapeRegExp(name)}\\s*=\\s*(["'])(.*?)\\1`, "i"));
  return match ? match[2].trim() : null;
}

function tagCount(text, tag) {
  return (text.match(new RegExp(`<${escapeRegExp(tag)}\\b`, "gi")) || []).length;
}

function collectPaintValues(text) {
  const values = [];
  const attrPattern = /\b(fill|stroke|color|flood-color|stop-color)\s*=\s*(["'])(.*?)\2/gi;
  for (const match of text.matchAll(attrPattern)) {
    values.push({ kind: "attribute", property: match[1].toLowerCase(), value: match[3].trim() });
  }
  const stylePattern = /\bstyle\s*=\s*(["'])(.*?)\1/gi;
  for (const styleMatch of text.matchAll(stylePattern)) {
    const declarationPattern = /(?:^|;)\s*(fill|stroke|color|flood-color|stop-color)\s*:\s*([^;]+)/gi;
    for (const match of styleMatch[2].matchAll(declarationPattern)) {
      values.push({ kind: "style", property: match[1].toLowerCase(), value: match[2].trim() });
    }
  }
  return values;
}

function findRisks(text) {
  const risks = [];
  if (/<!DOCTYPE\b/i.test(text)) risks.push("DOCTYPE declaration");
  if (/<!ENTITY\b/i.test(text)) risks.push("ENTITY declaration");
  if (/<\?xml-stylesheet\b/i.test(text)) risks.push("external XML stylesheet");
  for (const tag of DISALLOWED_TAGS) {
    if (tagCount(text, tag)) risks.push(`<${tag}>`);
  }
  if (/@import\b/i.test(text)) risks.push("CSS @import");
  const cssUrlPattern = /url\(\s*(["']?)(.*?)\1\s*\)/gi;
  for (const match of text.matchAll(cssUrlPattern)) {
    if (!match[2].startsWith("#")) risks.push(`external CSS url: ${match[2].slice(0, 80)}`);
  }
  if (/\son[a-z]+\s*=/i.test(text)) risks.push("event-handler attribute");
  const hrefPattern = /\b(?:href|xlink:href)\s*=\s*(["'])(.*?)\1/gi;
  for (const match of text.matchAll(hrefPattern)) {
    if (!match[2].startsWith("#")) risks.push(`external href: ${match[2].slice(0, 80)}`);
  }
  return [...new Set(risks)];
}

function scan(text) {
  const root = text.match(/<svg\b([^>]*)>/i);
  const attrs = root ? root[1] : "";
  const paintValues = collectPaintValues(text);
  const counts = {};
  for (const tag of ["path", "rect", "circle", "ellipse", "line", "polyline", "polygon", "g", "mask", "clipPath", "use"]) {
    counts[tag] = tagCount(text, tag);
  }
  return {
    width: attrValue(attrs, "width"),
    height: attrValue(attrs, "height"),
    viewBox: attrValue(attrs, "viewBox"),
    counts,
    colorSlots: Object.fromEntries(parseTokenStyles(text).values),
    paintValues: [...new Set(paintValues.map((item) => item.value))],
    risks: findRisks(text),
  };
}

function loadSharp() {
  const require = createRequire(import.meta.url);
  const candidates = ["sharp"];
  for (const root of (process.env.NODE_PATH || "").split(path.delimiter).filter(Boolean)) {
    candidates.push(path.join(root, "sharp"));
  }
  candidates.push(path.join(
    os.homedir(),
    ".cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/sharp",
  ));
  for (const candidate of candidates) {
    try {
      return require(candidate);
    } catch {
      // Continue through known runtime locations.
    }
  }
  throw new Error("The layout command requires sharp. Load the Codex workspace dependencies or expose sharp through NODE_PATH.");
}

async function renderedBounds(file, sharp) {
  const source = Buffer.from(readSvg(file));
  const { data, info } = await sharp(source)
    .resize(CANVAS_SIZE, CANVAS_SIZE, { fit: "fill" })
    .ensureAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });
  let left = info.width;
  let top = info.height;
  let right = -1;
  let bottom = -1;
  for (let y = 0; y < info.height; y += 1) {
    for (let x = 0; x < info.width; x += 1) {
      if (!data[(y * info.width + x) * 4 + 3]) continue;
      left = Math.min(left, x);
      top = Math.min(top, y);
      right = Math.max(right, x);
      bottom = Math.max(bottom, y);
    }
  }
  if (right < left || bottom < top) throw new Error(`SVG renders no visible pixels: ${file}`);
  const width = right - left + 1;
  const height = bottom - top + 1;
  return {
    left,
    top,
    right: right + 1,
    bottom: bottom + 1,
    width,
    height,
    centerX: left + width / 2,
    centerY: top + height / 2,
    footprint: Math.sqrt(width * height),
  };
}

function structuralComplexity(text) {
  const geometry = [...text.matchAll(/<(path|rect|circle|ellipse|line|polyline|polygon)\b([^>]*)>/gi)];
  const paths = geometry.filter((match) => match[1].toLowerCase() === "path");
  const pathCommandCount = paths.reduce((sum, match) => {
    const d = attrValue(match[2], "d") || "";
    return sum + (d.match(/[MmLlHhVvCcSsQqTtAaZz]/g) || []).length;
  }, 0);
  return { geometryCount: geometry.length, pathCount: paths.length, pathCommandCount };
}

async function renderedComplexity(file, sharp) {
  const source = Buffer.from(readSvg(file));
  const { data, info } = await sharp(source)
    .resize(CANVAS_SIZE, CANVAS_SIZE, { fit: "fill" })
    .ensureAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });
  let opaqueArea = 0;
  let edgeTransitions = 0;
  const different = (first, second) => {
    const firstOpaque = data[first + 3] > 127;
    const secondOpaque = data[second + 3] > 127;
    if (firstOpaque !== secondOpaque) return true;
    if (!firstOpaque) return false;
    return Math.abs(data[first] - data[second])
      + Math.abs(data[first + 1] - data[second + 1])
      + Math.abs(data[first + 2] - data[second + 2]) > 36;
  };
  for (let y = 0; y < info.height; y += 1) {
    for (let x = 0; x < info.width; x += 1) {
      const index = (y * info.width + x) * 4;
      if (data[index + 3] > 127) opaqueArea += 1;
      if (x + 1 < info.width && different(index, index + 4)) edgeTransitions += 1;
      if (y + 1 < info.height && different(index, index + info.width * 4)) edgeTransitions += 1;
    }
  }
  const structure = structuralComplexity(readSvg(file));
  return {
    ...structure,
    opaqueArea,
    edgeTransitions,
    edgeDensity: edgeTransitions / Math.sqrt(opaqueArea),
  };
}

function median(values) {
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
}

function parseLayoutArgs(args) {
  const references = [];
  let asJson = false;
  for (let index = 0; index < args.length; index += 1) {
    if (args[index] === "--json") {
      asJson = true;
    } else if (args[index] === "--reference" && index + 1 < args.length) {
      references.push(args[index + 1]);
      index += 1;
    } else {
      throw new Error(`Invalid layout argument: ${args[index]}`);
    }
  }
  return { references, asJson };
}

function resolveReferenceFiles(inputs) {
  const files = [];
  for (const input of inputs) {
    const stat = fs.statSync(input);
    if (stat.isDirectory()) {
      files.push(...fs.readdirSync(input)
        .filter((name) => path.extname(name).toLowerCase() === ".svg")
        .sort()
        .map((name) => path.join(input, name)));
    } else if (stat.isFile() && path.extname(input).toLowerCase() === ".svg") {
      files.push(input);
    } else {
      throw new Error(`Reference must be an SVG file or a directory containing SVG files: ${input}`);
    }
  }
  return [...new Set(files.map((file) => path.resolve(file)))];
}

async function auditLayout(file, args) {
  const { references, asJson } = parseLayoutArgs(args);
  const sharp = loadSharp();
  const bounds = await renderedBounds(file, sharp);
  const referenceFiles = resolveReferenceFiles(references);
  const referenceBounds = await Promise.all(referenceFiles.map((reference) => renderedBounds(reference, sharp)));
  const target = referenceBounds.length ? {
    centerX: median(referenceBounds.map((item) => item.centerX)),
    centerY: median(referenceBounds.map((item) => item.centerY)),
    footprint: median(referenceBounds.map((item) => item.footprint)),
  } : DEFAULT_LAYOUT;
  const delta = {
    centerX: bounds.centerX - target.centerX,
    centerY: bounds.centerY - target.centerY,
    footprint: bounds.footprint - target.footprint,
  };
  const errors = [];
  if (Math.abs(delta.centerX) > CENTER_TOLERANCE) {
    errors.push(`Visible subject center is ${Math.abs(delta.centerX).toFixed(1)} px too far ${delta.centerX > 0 ? "right" : "left"}; tolerance is ${CENTER_TOLERANCE} px.`);
  }
  if (Math.abs(delta.centerY) > CENTER_TOLERANCE) {
    errors.push(`Visible subject center is ${Math.abs(delta.centerY).toFixed(1)} px too far ${delta.centerY > 0 ? "down" : "up"}; tolerance is ${CENTER_TOLERANCE} px.`);
  }
  if (Math.abs(delta.footprint) > FOOTPRINT_TOLERANCE) {
    errors.push(`Visible footprint differs from the reference by ${Math.abs(delta.footprint).toFixed(1)} px; tolerance is ${FOOTPRINT_TOLERANCE} px.`);
  }
  const report = { file: path.resolve(file), ok: errors.length === 0, bounds, target, delta, referenceCount: referenceBounds.length, errors };
  if (asJson) {
    console.log(JSON.stringify(report, null, 2));
  } else {
    console.log(`${errors.length ? "FAIL" : "PASS"}: ${report.file}`);
    console.log(`Visible bounds: x=${bounds.left}..${bounds.right}, y=${bounds.top}..${bounds.bottom}, ${bounds.width} × ${bounds.height}`);
    console.log(`Center: (${bounds.centerX.toFixed(1)}, ${bounds.centerY.toFixed(1)}); delta=(${delta.centerX.toFixed(1)}, ${delta.centerY.toFixed(1)}) px`);
    console.log(`Equivalent footprint: ${bounds.footprint.toFixed(1)} px; delta=${delta.footprint.toFixed(1)} px; references=${referenceBounds.length || "built-in baseline"}`);
    for (const error of errors) console.log(`ERROR: ${error}`);
  }
  if (errors.length) process.exitCode = 1;
}

async function auditComplexity(file, args) {
  const { references, asJson } = parseLayoutArgs(args);
  const sharp = loadSharp();
  const metrics = await renderedComplexity(file, sharp);
  const referenceFiles = resolveReferenceFiles(references);
  const referenceMetrics = await Promise.all(referenceFiles.map((reference) => renderedComplexity(reference, sharp)));
  const targetDensity = referenceMetrics.length
    ? median(referenceMetrics.map((item) => item.edgeDensity))
    : DEFAULT_COMPLEXITY.edgeDensity;
  const tolerance = referenceMetrics.length
    ? Math.max(4, targetDensity * 0.2)
    : DEFAULT_COMPLEXITY.tolerance;
  const range = { min: targetDensity - tolerance, max: targetDensity + tolerance };
  const errors = [];
  if (metrics.edgeDensity < range.min) {
    errors.push(`Visual complexity is too low: edge density ${metrics.edgeDensity.toFixed(1)} is below ${range.min.toFixed(1)}.`);
  }
  if (metrics.edgeDensity > range.max) {
    errors.push(`Visual complexity is too high: edge density ${metrics.edgeDensity.toFixed(1)} exceeds ${range.max.toFixed(1)}.`);
  }
  const report = {
    file: path.resolve(file),
    ok: errors.length === 0,
    metrics,
    target: { edgeDensity: targetDensity, tolerance, range },
    referenceCount: referenceMetrics.length,
    errors,
  };
  if (asJson) {
    console.log(JSON.stringify(report, null, 2));
  } else {
    console.log(`${errors.length ? "FAIL" : "PASS"}: ${report.file}`);
    console.log(`Visual edge density: ${metrics.edgeDensity.toFixed(1)}; target=${targetDensity.toFixed(1)}; range=${range.min.toFixed(1)}..${range.max.toFixed(1)}`);
    console.log(`Geometry: ${metrics.geometryCount}; paths=${metrics.pathCount}; path commands=${metrics.pathCommandCount}; opaque area=${metrics.opaqueArea}`);
    for (const error of errors) console.log(`ERROR: ${error}`);
  }
  if (errors.length) process.exitCode = 1;
}

function parseTokenStyles(text) {
  const styleBlocks = [...text.matchAll(/<style\b[^>]*>([\s\S]*?)<\/style>/gi)];
  const values = new Map();
  let css = styleBlocks.map((match) => match[1]).join("\n");
  css = css.replace(/\/\*[\s\S]*?\*\//g, "");
  for (const [name] of TOKENS) {
    const pattern = new RegExp(`\\.${escapeRegExp(name)}\\s*\\{\\s*color\\s*:\\s*(#[0-9a-f]{6})\\s*;?\\s*\\}`, "i");
    const matches = [...css.matchAll(new RegExp(pattern.source, "gi"))];
    if (matches.length === 1) values.set(name, matches[0][1]);
    css = css.replace(new RegExp(pattern.source, "gi"), "");
  }
  return { styleBlockCount: styleBlocks.length, values, leftoverCss: css.replace(/\s+/g, "") };
}

const TOKEN_NAMES = new Set(TOKENS.map(([name]) => name));

function classToken(attrs) {
  const classes = (attrValue(attrs, "class") || "").split(/\s+/).filter(Boolean);
  const matches = classes.filter((name) => TOKEN_NAMES.has(name));
  return matches.length === 1 ? matches[0] : null;
}

function paintToken(attrs, property) {
  const explicit = attrValue(attrs, `data-${property}-token`);
  if (explicit) return explicit;
  return attrValue(attrs, property) === "currentColor" ? classToken(attrs) : null;
}

function isHexPaint(value) {
  return /^#[0-9a-f]{6}$/i.test(value || "");
}

function clippedGeometryIndices(text) {
  const indices = new Set();
  const clippedStack = [];
  const pattern = /<\/g\s*>|<g\b([^>]*)>|<(path|rect|circle|ellipse|line|polyline|polygon)\b([^>]*)>/gi;
  for (const match of text.matchAll(pattern)) {
    if (/^<\/g/i.test(match[0])) {
      clippedStack.pop();
      continue;
    }
    if (match[1] !== undefined) {
      const clipped = Boolean(clippedStack.at(-1)) || Boolean(attrValue(match[1], "clip-path"));
      if (!/\/\s*>$/.test(match[0])) clippedStack.push(clipped);
      continue;
    }
    if (Boolean(clippedStack.at(-1)) || Boolean(attrValue(match[3], "clip-path"))) {
      indices.add(match.index);
    }
  }
  return indices;
}

function insideDefs(text, index) {
  const lower = text.toLowerCase();
  return lower.lastIndexOf("<defs", index) > lower.lastIndexOf("</defs>", index);
}

function rewriteGeometryTags(text, update) {
  return text.replace(/<(path|rect|circle|ellipse|line|polyline|polygon)\b([^>]*)>/gi, (whole, tag, attrs) => {
    const changes = update(tag, attrs);
    if (!changes || !Object.keys(changes).length) return whole;
    const selfClosing = /\/\s*$/.test(attrs);
    let nextAttrs = attrs.replace(/\/\s*$/, "");
    for (const [name, value] of Object.entries(changes)) {
      const pattern = new RegExp(`\\b${escapeRegExp(name)}\\s*=\\s*(["']).*?\\1`, "i");
      if (pattern.test(nextAttrs)) nextAttrs = nextAttrs.replace(pattern, `${name}="${value}"`);
      else nextAttrs += ` ${name}="${value}"`;
    }
    return `<${tag}${nextAttrs}${selfClosing ? "/" : ""}>`;
  });
}

function relativeLuminance(hex) {
  const channels = hex.slice(1).match(/.{2}/g).map((part) => Number.parseInt(part, 16) / 255);
  const linear = channels.map((value) => value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4);
  return 0.2126 * linear[0] + 0.7152 * linear[1] + 0.0722 * linear[2];
}

function auditText(text) {
  const errors = [];
  const warnings = [];
  const root = text.match(/<svg\b([^>]*)>/i);
  if (!root) return { errors: ["Missing <svg> root."], warnings, summary: scan(text) };

  const width = attrValue(root[1], "width");
  const height = attrValue(root[1], "height");
  const viewBox = attrValue(root[1], "viewBox");
  if (width !== "154") errors.push(`width must be 154, found ${width ?? "missing"}.`);
  if (height !== "154") errors.push(`height must be 154, found ${height ?? "missing"}.`);
  const viewBoxNumbers = (viewBox || "").trim().split(/[\s,]+/).map(Number);
  if (viewBoxNumbers.length !== 4 || viewBoxNumbers.some(Number.isNaN) || viewBoxNumbers.join(",") !== "0,0,154,154") {
    errors.push(`viewBox must be "0 0 154 154", found ${viewBox ?? "missing"}.`);
  }

  const faceFeatureSpec = attrValue(root[1], "data-face-features");
  const hasExpressionGroup = /<g\b[^>]*\bid\s*=\s*(["'])expression(?:-[^"']+)?\1/i.test(text);
  if (hasExpressionGroup && !faceFeatureSpec) {
    errors.push("Character SVGs with an expression group must declare data-face-features on the root <svg>.");
  }
  if (faceFeatureSpec) {
    const features = faceFeatureSpec.trim().split(/\s+/).filter(Boolean);
    const allowedFeatures = new Set(["none", "eyes", "nose", "mouth"]);
    const unknownFeatures = features.filter((feature) => !allowedFeatures.has(feature));
    if (unknownFeatures.length) errors.push(`Unknown data-face-features value: ${[...new Set(unknownFeatures)].join(", ")}.`);
    if (new Set(features).size !== features.length) errors.push("data-face-features must not repeat a feature category.");
    if (features.includes("none") && features.length !== 1) errors.push('data-face-features="none" cannot be combined with another feature.');
    if (["eyes", "nose", "mouth"].every((feature) => features.includes(feature))) {
      errors.push("Eyes, nose, and mouth must never appear together; use at most two facial-feature categories.");
    }
  }

  const risks = findRisks(text);
  for (const risk of risks) errors.push(`Disallowed or unsafe SVG feature: ${risk}.`);

  const tokenData = parseTokenStyles(text);
  if (tokenData.styleBlockCount !== 1) errors.push(`Exactly one <style> block is required; found ${tokenData.styleBlockCount}.`);
  for (const [name] of TOKENS) {
    if (!tokenData.values.has(name)) errors.push(`Missing or duplicated .${name} color rule.`);
  }
  if (TOKENS.every(([name]) => tokenData.values.has(name))) {
    const ordered = TOKENS.map(([name]) => [name, relativeLuminance(tokenData.values.get(name))]);
    for (let index = 1; index < ordered.length; index += 1) {
      if (ordered[index - 1][1] >= ordered[index][1]) {
        errors.push(`Physical value order is invalid: ${ordered[index - 1][0]} must be darker than ${ordered[index][0]}.`);
      }
    }
    if (tokenData.values.get("icon-white").toUpperCase() !== "#FFFFFF") {
      warnings.push("Default deliverables should use pure white #FFFFFF for icon-white unless the user supplied a theme palette.");
    }
  }
  if (tokenData.leftoverCss) errors.push("The <style> block may contain only the five color-slot rules.");
  if (/--[a-z0-9-]+\s*:/i.test(text)) errors.push("CSS custom properties are not allowed; use explicit editor-safe paints with token markers.");

  const tokenUses = new Map(TOKENS.map(([name]) => [name, 0]));
  const paintedElements = [...text.matchAll(/<(path|rect|circle|ellipse|line|polyline|polygon)\b([^>]*)>/gi)];
  const clippedIndices = clippedGeometryIndices(text);
  for (const [, tag, attrs] of paintedElements) {
    const fill = attrValue(attrs, "fill");
    const stroke = attrValue(attrs, "stroke");
    if (!fill && !stroke) errors.push(`<${tag}> must explicitly declare fill and/or stroke; implicit black is forbidden.`);
    for (const [property, value] of [["fill", fill], ["stroke", stroke]]) {
      if (!value || value === "none") continue;
      if (value === "currentColor") {
        errors.push(`<${tag}> uses currentColor for ${property}; materialize an explicit #RRGGBB paint for design-editor import.`);
        continue;
      }
      if (!isHexPaint(value)) {
        errors.push(`<${tag}> ${property} uses ${value}; visible paint must be an opaque #RRGGBB value or none.`);
        continue;
      }
      const token = paintToken(attrs, property);
      if (!TOKEN_NAMES.has(token)) {
        errors.push(`<${tag}> with ${property}=${value} must declare data-${property}-token with one of the five token names.`);
        continue;
      }
      const expected = tokenData.values.get(token);
      if (expected && expected.toUpperCase() !== value.toUpperCase()) {
        errors.push(`<${tag}> ${property}=${value} does not match ${token}=${expected}.`);
      }
      tokenUses.set(token, tokenUses.get(token) + 1);
    }
    if (fill && fill !== "none" && stroke && stroke !== "none" && paintToken(attrs, "stroke") !== "icon-outline") {
      errors.push(`<${tag}> has a filled shape whose visible contour is not bound to icon-outline.`);
    }
  }
  for (const match of paintedElements) {
    const [, tag, attrs] = match;
    const fillToken = paintToken(attrs, "fill");
    const stroke = attrValue(attrs, "stroke");
    if (!["icon-dark", "icon-light", "icon-white"].includes(fillToken)) continue;
    if (stroke && stroke !== "none") continue;
    if (insideDefs(text, match.index) || clippedIndices.has(match.index) || attrValue(attrs, "clip-path")) continue;
    errors.push(`<${tag}> using ${fillToken} without its own contour must be inside a clipped object group so the tone plane cannot cover or escape the enclosing outline.`);
  }
  for (const [name, uses] of tokenUses) {
    if (!uses) errors.push(`.${name} is defined but not used by any painted element.`);
  }

  let scrubbed = text;
  for (const [name] of TOKENS) {
    scrubbed = scrubbed.replace(new RegExp(`(\\.${escapeRegExp(name)}\\s*\\{\\s*color\\s*:\\s*)#[0-9a-f]{6}`, "gi"), "$1TOKEN");
  }
  const allowedColors = new Set([...tokenData.values.values()].map((value) => value.toUpperCase()));
  const strayColors = (scrubbed.match(/#[0-9a-f]{3,8}\b|\brgba?\s*\(|\bhsla?\s*\(/gi) || [])
    .filter((value) => !allowedColors.has(value.toUpperCase()));
  if (strayColors.length) errors.push(`Found color literals outside the five root token definitions: ${[...new Set(strayColors)].join(", ")}.`);

  const opacityPattern = /\b(?:opacity|fill-opacity|stroke-opacity|stop-opacity)\s*=\s*(["'])(.*?)\1/gi;
  for (const match of text.matchAll(opacityPattern)) {
    if (Number(match[2]) !== 1) errors.push(`Transparency is not allowed: ${match[0]}.`);
  }
  if (/(?:^|;)\s*(?:opacity|fill-opacity|stroke-opacity|stop-opacity)\s*:/im.test(text)) {
    errors.push("Transparency declarations in style attributes are not allowed.");
  }

  const geometryCount = ["path", "rect", "circle", "ellipse", "line", "polyline", "polygon"]
    .reduce((sum, tag) => sum + tagCount(text, tag), 0);
  if (!geometryCount) errors.push("No vector geometry found.");
  if (geometryCount > 40) warnings.push(`High geometry count (${geometryCount}); simplify unless the subject truly needs it.`);
  if (Buffer.byteLength(text, "utf8") > 250 * 1024) warnings.push("SVG is larger than 250 KB; inspect for leftover source complexity.");

  const ids = [...text.matchAll(/\bid\s*=\s*(["'])(.*?)\1/gi)].map((match) => match[2]);
  const duplicateIds = [...new Set(ids.filter((id, index) => ids.indexOf(id) !== index))];
  if (duplicateIds.length) errors.push(`Duplicate id values: ${duplicateIds.join(", ")}.`);

  if (!/<title\b/i.test(text)) warnings.push("Add a concise <title> describing the subject.");
  if (!paintedElements.some(([, , attrs]) => paintToken(attrs, "stroke") === "icon-outline")) {
    errors.push("At least one visible contour must use data-stroke-token=\"icon-outline\".");
  }
  const hardShadowGroup = text.match(/<g\b[^>]*\bid\s*=\s*(["'])hard-shadow\1[^>]*>([\s\S]*?)<\/g>/i);
  const hardShadowElements = hardShadowGroup
    ? [...hardShadowGroup[2].matchAll(/<(path|rect|circle|ellipse|polygon)\b([^>]*)>/gi)]
    : [];
  if (!hardShadowElements.some(([, , attrs]) => paintToken(attrs, "fill") === "icon-outline")) {
    errors.push("A hard-shadow group using a filled icon-outline silhouette is required.");
  }
  if (hardShadowElements.some(([, , attrs]) => paintToken(attrs, "fill") === "icon-outline"
    && (paintToken(attrs, "stroke") !== "icon-outline" || Number(attrValue(attrs, "stroke-width")) < 4.2))) {
    errors.push("Every hard-shadow silhouette must use an icon-outline stroke of at least 4.2 px so exposed joins stay rounded.");
  }
  const highlightGroup = text.match(/<g\b[^>]*\bid\s*=\s*(["'])highlight\1[^>]*>([\s\S]*?)<\/g>/i);
  const highlightElements = highlightGroup
    ? [...highlightGroup[2].matchAll(/<(path|rect|circle|ellipse)\b([^>]*)>/gi)]
    : [];
  if (!highlightElements.some(([, , attrs]) => paintToken(attrs, "fill") === "icon-white")) {
    errors.push("Add a dedicated filled surface in <g id=\"highlight\"> using icon-white; eyes and thin highlight strokes are not sufficient.");
  }
  const widths = [...text.matchAll(/\bstroke-width\s*=\s*(["'])([0-9.]+)\1/gi)].map((match) => Number(match[2]));
  if (!widths.some((value) => Math.abs(value - 4.2) < 0.001)) errors.push("A 4.2 px primary outline is required.");
  for (const [, tag, attrs] of paintedElements) {
    const stroke = attrValue(attrs, "stroke");
    if (!stroke || stroke === "none") continue;
    const width = Number(attrValue(attrs, "stroke-width"));
    if (!Number.isFinite(width)) errors.push(`<${tag}> strokes must declare stroke-width explicitly.`);
    else if (width < 4.2) errors.push(`<${tag}> uses a ${width} px stroke; visible structural lines must be at least 4.2 px.`);
  }
  if (/<g\b[^>]*\bid\s*=\s*(["'])contour\1/i.test(text)) {
    errors.push("Do not use a final global contour group; finish each object's contour inside its semantic layer so foreground fills occlude background lines.");
  }
  if (!/stroke-linecap\s*=\s*(["'])round\1/i.test(text)) errors.push("Use round stroke-linecap.");
  if (!/stroke-linejoin\s*=\s*(["'])round\1/i.test(text)) errors.push("Use round stroke-linejoin.");

  return { errors: [...new Set(errors)], warnings: [...new Set(warnings)], summary: scan(text) };
}

function printInspection(file, report, asJson) {
  if (asJson) {
    console.log(JSON.stringify({ file: path.resolve(file), ...report }, null, 2));
    return;
  }
  console.log(`SVG: ${path.resolve(file)}`);
  console.log(`Canvas: ${report.width ?? "?"} × ${report.height ?? "?"}; viewBox: ${report.viewBox ?? "?"}`);
  console.log(`Elements: ${Object.entries(report.counts).filter(([, count]) => count).map(([tag, count]) => `${tag}=${count}`).join(", ") || "none"}`);
  console.log(`Color slots: ${Object.entries(report.colorSlots).map(([name, value]) => `${name}=${value}`).join(", ") || "none"}`);
  console.log(`Paint values: ${report.paintValues.join(", ") || "none"}`);
  console.log(`Risk markers: ${report.risks.join(", ") || "none"}`);
}

function printAudit(file, report, asJson) {
  if (asJson) {
    console.log(JSON.stringify({ file: path.resolve(file), ok: report.errors.length === 0, ...report }, null, 2));
    return;
  }
  console.log(`${report.errors.length ? "FAIL" : "PASS"}: ${path.resolve(file)}`);
  for (const item of report.errors) console.log(`ERROR: ${item}`);
  for (const item of report.warnings) console.log(`WARN: ${item}`);
  if (!report.errors.length && !report.warnings.length) console.log("Five-token SVG contract satisfied.");
}

function parseRecolorArgs(args) {
  const flags = new Map();
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--force") {
      flags.set("force", true);
      continue;
    }
    if (!arg.startsWith("--") || index + 1 >= args.length) throw new Error(`Invalid recolor argument: ${arg}`);
    flags.set(arg.slice(2), args[index + 1]);
    index += 1;
  }
  return flags;
}

function outputPath(input, flags) {
  const output = flags.get("out");
  if (!output || path.extname(output).toLowerCase() !== ".svg") throw new Error("--out must name a .svg file.");
  if (path.resolve(input) === path.resolve(output) && !flags.get("force")) {
    throw new Error("Input and output may match only with --force after explicit overwrite approval.");
  }
  if (fs.existsSync(output) && !flags.get("force")) throw new Error("Output exists. Use a new path or pass --force after explicit overwrite approval.");
  return output;
}

function materialize(input, args) {
  const flags = parseRecolorArgs(args);
  const output = outputPath(input, flags);
  const text = readSvg(input);
  const risks = findRisks(text);
  if (risks.length) throw new Error(`Cannot materialize unsafe SVG features: ${risks.join(", ")}.`);
  const tokenData = parseTokenStyles(text);
  if (tokenData.styleBlockCount !== 1 || TOKENS.some(([name]) => !tokenData.values.has(name))) {
    throw new Error("Input must define the five color slots in exactly one <style> block.");
  }
  const next = rewriteGeometryTags(text, (tag, attrs) => {
    const changes = {};
    const fill = attrValue(attrs, "fill");
    const stroke = attrValue(attrs, "stroke");
    const token = classToken(attrs);
    if (fill === "currentColor") {
      if (!token) throw new Error(`<${tag}> cannot resolve its currentColor fill to one token class.`);
      changes.fill = tokenData.values.get(token).toUpperCase();
      changes["data-fill-token"] = token;
    }
    if (stroke === "currentColor") {
      if (!token) throw new Error(`<${tag}> cannot resolve its currentColor stroke to one token class.`);
      const strokeToken = attrValue(attrs, "data-stroke-token")
        || (fill === "currentColor" && token !== "icon-outline" ? "icon-outline" : token);
      changes.stroke = tokenData.values.get(strokeToken).toUpperCase();
      changes["data-stroke-token"] = strokeToken;
    }
    return changes;
  });
  const after = auditText(next);
  if (after.errors.length) throw new Error(`Materialized SVG failed audit: ${after.errors.join(" ")}`);
  fs.writeFileSync(output, next, { encoding: "utf8", flag: flags.get("force") ? "w" : "wx" });
  console.log(`Wrote ${path.resolve(output)}`);
  printAudit(output, after, false);
}

function recolor(input, args) {
  const flags = parseRecolorArgs(args);
  const output = outputPath(input, flags);

  const text = readSvg(input);
  const before = auditText(text);
  if (before.errors.length) {
    printAudit(input, before, false);
    throw new Error("Input must pass audit before recoloring.");
  }

  let next = text;
  const theme = new Map();
  for (const [token, , flag] of TOKENS) {
    const value = flags.get(flag);
    if (!value || !/^#[0-9a-f]{6}$/i.test(value)) throw new Error(`--${flag} requires an opaque #RRGGBB value.`);
    theme.set(token, value.toUpperCase());
    const pattern = new RegExp(`(\\.${escapeRegExp(token)}\\s*\\{\\s*color\\s*:\\s*)#[0-9a-f]{6}`, "i");
    if (!pattern.test(next)) throw new Error(`Cannot locate .${token} in the color-slot declarations.`);
    next = next.replace(pattern, `$1${value.toUpperCase()}`);
  }
  next = rewriteGeometryTags(next, (tag, attrs) => {
    const changes = {};
    for (const property of ["fill", "stroke"]) {
      const token = attrValue(attrs, `data-${property}-token`);
      if (token && theme.has(token)) changes[property] = theme.get(token);
    }
    return changes;
  });

  const after = auditText(next);
  if (after.errors.length) throw new Error(`Recolored SVG failed audit: ${after.errors.join(" ")}`);
  fs.writeFileSync(output, next, { encoding: "utf8", flag: flags.get("force") ? "w" : "wx" });
  console.log(`Wrote ${path.resolve(output)}`);
  printAudit(output, after, false);
}

const [command, file, ...args] = process.argv.slice(2);
if (!command || command === "--help" || command === "-h") usage(0);
if (!file) usage(2);

try {
  if (command === "inspect") {
    printInspection(file, scan(readSvg(file)), args.includes("--json"));
  } else if (command === "audit") {
    const report = auditText(readSvg(file));
    printAudit(file, report, args.includes("--json"));
    if (report.errors.length) process.exitCode = 1;
  } else if (command === "layout") {
    await auditLayout(file, args);
  } else if (command === "complexity") {
    await auditComplexity(file, args);
  } else if (command === "materialize") {
    materialize(file, args);
  } else if (command === "recolor") {
    recolor(file, args);
  } else {
    usage(2);
  }
} catch (error) {
  console.error(`ERROR: ${error.message}`);
  process.exitCode = 2;
}
