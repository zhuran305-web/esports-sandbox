/*
 * 约战 extra 体积估算与狠话硬闸（1.2.16）
 * 分享链接 extra 上限 128 字节（MessagePack 编码后）。d:1 七字段实测典型 ~80-92B、
 * 最坏（超长 id + 12 字昵称）~110B；狠话用单字符键 g（1 汉字 3B），UI 限 12 字。
 * 估算器只覆盖本协议形态：扁平对象、键为短 ASCII、值只有 number/string；
 * 与 @msgpack/msgpack 编码逐字节对拍（test:cloud 场景 T），改编码规则须两处同步。
 */

export function utf8Len(s) {
  var n = 0;
  for (var i = 0; i < s.length; i++) {
    var c = s.charCodeAt(i);
    if (c >= 0xd800 && c <= 0xdbff) { n += 4; i++; } // 代理对（emoji 等）= 4B
    else n += c < 0x80 ? 1 : c < 0x800 ? 2 : 3;
  }
  return n;
}

export function duelExtraBytes(extra) {
  var keys = Object.keys(extra);
  var total = keys.length <= 15 ? 1 : 3; // fixmap / map16
  keys.forEach(function (k) {
    total += 1 + k.length; // 键恒为短 ASCII（fixstr）
    var v = extra[k];
    if (typeof v === "number") total += v >= 0 && v <= 127 ? 1 : v <= 65535 ? 3 : 5; // fixint / uint16 / uint32
    else {
      var b = utf8Len(String(v));
      total += b <= 31 ? 1 + b : b <= 255 ? 2 + b : 4 + b; // fixstr / str8 / str16
    }
  });
  return total;
}

/** 硬闸：超上限时从尾部逐字截狠话，仍超则去掉狠话。纯函数不弹 toast（应用层按 trimmed/dropped 提示）。 */
export function fitDuelExtra(extra, max) {
  var cap = max || 128;
  var out = Object.assign({}, extra);
  var g = out.g || "";
  while (g && duelExtraBytes(Object.assign({}, out, { g: g })) > cap) g = g.slice(0, -1);
  if (g) out.g = g;
  else delete out.g;
  return {
    extra: out,
    trimmed: !!extra.g && !!out.g && out.g !== extra.g,
    dropped: !!extra.g && !out.g
  };
}
