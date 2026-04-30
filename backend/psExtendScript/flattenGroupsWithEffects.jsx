// flattenGroupsWithEffects.jsx
// ────────────────────────────────────────────────────────────────────────
// 把"自身带启用图层样式（layer effects）"的图层组（LayerSet）合并成单层。
//
// 用途定位：
//   跟在 "Flatten All Layer Effects.jsx" 之后跑。Adobe 的 Flatten All Layer
//   Effects 主要处理 ArtLayer 的样式（栅格化每一层的 fx），但**保留 LayerSet
//   层级**——LayerSet 自身的 effects 不会被栅格化（因为栅格化整组会把组拍平
//   丢失结构）。本脚本兜底处理这种情况：组本身有 effects 时，把它合并成单层，
//   合并后的单层带着原组的 effects 继续往下走（之后还会再被栅格化掉）。
//
// 合并语义（沿用 PS 内置 LayerSet.merge() 的行为，等价于 UI 上 Cmd+E on group）：
//   · "拼合可见"：组内不可见子图层会被丢弃，可见的合并到一个新 ArtLayer。
//     （我们流程的前一步 Delete All Empty Layers 已经删过隐藏层，正常应该
//     没有隐藏剩余；这里再被丢一次也无妨。）
//   · "遵循剪切蒙版"：组内的剪贴蒙版关系由 PS 自己处理——base 像素会被上方
//     clipping layers 按各自规则限定。
//   · 组的 blend_mode / opacity / fill_opacity / mask / effects 都保留到合
//     并后的新 ArtLayer 上（PS 自动处理）。
//
// 嵌套处理：
//   反向遍历目标列表（先深层子组、再浅层父组），保证嵌套场景下每一层都被
//   独立判定 + 合并，避免父组合并时把还没处理的子组 effects 一起烤进去。
//
// 双重身份（同 saveAsClean.jsx）：
//   · 子流程被 AppleScript do javascript 调用：不弹 alert，末尾 IIFE return
//     一个状态字符串供日志查看。
//   · 用户从 PS 菜单 File → Scripts → Browse... 跑：仍能正常运行，看 PS 的
//     ExtendScript Toolkit / Console 能拿到统计字符串。
// ────────────────────────────────────────────────────────────────────────

#target photoshop

// 末尾 IIFE 的返回值即文件返回值；AppleScript do javascript 拿到它做日志。
(function () {
    if (app.documents.length === 0) return "no document";

    var doc = app.activeDocument;
    var scanned = 0;
    var flattened = 0;
    var errors = 0;

    var targets = [];
    collectLayerSets(doc, targets);
    scanned = targets.length;

    // 反向遍历 = 先深后浅（先合并嵌套子组、再合并父组）
    for (var i = targets.length - 1; i >= 0; i--) {
        var grp = targets[i];
        try {
            if (!hasEnabledLayerEffects(grp)) continue;
            doc.activeLayer = grp;
            // LayerSet.merge() 等价 UI 里在组上按 Cmd+E：合并所有可见子图层
            // 为一个新 ArtLayer，遵循剪切蒙版关系，组的 effects 保留到新层
            grp.merge();
            flattened++;
        } catch (e) {
            errors++;
            $.writeln("flatten group failed: " + e);
        }
    }

    return "scanned=" + scanned + ", flattened=" + flattened + ", errors=" + errors;

    // ─── helpers ────────────────────────────────────────────────────

    // 递归收集所有 LayerSet（含嵌套）；返回顺序是"先父后子（深度优先）"，
    // 调用方反向遍历即得到"先子后父"。
    function collectLayerSets(parent, out) {
        for (var i = 0; i < parent.layers.length; i++) {
            var l = parent.layers[i];
            if (l.typename === "LayerSet") {
                out.push(l);
                collectLayerSets(l, out);
            }
        }
    }

    // 检测 LayerSet 是否含"启用中"的 layer effects。
    // 用 ActionManager 而不是 DOM 的 layer.layerEffects 属性——后者在没启用过
    // 样式的图层上访问会抛 GeneralError，不可靠。逻辑跟 rasterize 类脚本一致。
    function hasEnabledLayerEffects(layer) {
        try {
            var ref = new ActionReference();
            ref.putIdentifier(stringIDToTypeID("layer"), layer.id);
            var desc = executeActionGet(ref);

            var fxKey = stringIDToTypeID("layerEffects");
            if (!desc.hasKey(fxKey)) return false;

            var fx = desc.getObjectValue(fxKey);

            // 总开关：layerFXVisible=false 表示样式整体被禁用
            var fxVisKey = stringIDToTypeID("layerFXVisible");
            if (fx.hasKey(fxVisKey) && fx.getBoolean(fxVisKey) === false) return false;

            // layerEffects 里 scale / layerFXVisible 不算 effect 本身；
            // 排除后还有任何 key 就视为"有 effect"
            for (var i = 0; i < fx.count; i++) {
                var key = fx.getKey(i);
                var name = typeIDToStringID(key);
                if (name === "scale" || name === "layerFXVisible") continue;
                return true;
            }
            return false;
        } catch (e) {
            return false;
        }
    }
})();
