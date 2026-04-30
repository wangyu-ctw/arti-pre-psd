// flattenClippingMasks.jsx
// ────────────────────────────────────────────────────────────────────────
// 把所有"剪切蒙版组"合并成单个 ArtLayer，并把合并后图层（来源于 base）的
// layer effects 也栅格化掉。
//
// 用途定位：
//   接在 Flatten All Masks.jsx 之后跑。Flatten All Layer Effects 会漏掉
//   "作为剪切蒙版底图（base）的图层"——它的 effects 不会被烧入像素。本脚本
//   兜底：把每个剪切蒙版组（base + 上方所有 clipped layers）合并成一个 ArtLayer，
//   合并后如果还残留 effects（来自 base），再栅格化掉。
//
// 处理策略（按用户配置）：
//   · 范围：处理**所有**剪切蒙版组（不管 base 是否带 effects）。等于把所有
//     clipping mask 关系全部消除，让后续步骤拿到平的图层结构。
//   · LayerSet 作 base：先 LayerSet.merge() 合并组内可见层为单 ArtLayer，
//     再当 base 处理。
//   · 合并方式：在 top clip layer 上调 ArtLayer.merge() —— PS DOM 文档说这
//     会自动 merge 整个 clip group（含 base）。
//
// 主循环用"找第一个未处理过的 clip base → 处理 → 重新扫描"模式：
//   · 每次合并都会改变 layers 树（删掉若干层、新建一个），缓存的引用都会失效。
//   · 重新扫描虽然多走几次树，但稳定性最好；安全 cap 在 1000 次迭代。
//   · 单个 base 失败时记入 failedIds，下次 findFirstClipBase 跳过，避免死循环。
// ────────────────────────────────────────────────────────────────────────

#target photoshop

(function () {
    if (app.documents.length === 0) return "no document";

    var doc = app.activeDocument;
    var processed = 0;
    var skipped = 0;
    var errors = 0;
    var failedIds = {};
    var iter = 0;
    var MAX_ITER = 1000;

    while (iter < MAX_ITER) {
        iter++;
        var base = findFirstClipBase(doc, failedIds);
        if (base === null) break;
        try {
            var did = mergeAndRasterize(base);
            if (did) processed++;
            else {
                skipped++;
                failedIds[base.id] = true;
            }
        } catch (e) {
            errors++;
            $.writeln("clip merge failed (id=" + base.id + "): " + e);
            failedIds[base.id] = true;
        }
    }

    return "processed=" + processed + ", skipped=" + skipped +
           ", errors=" + errors + ", iter=" + iter;

    // ─── helpers ────────────────────────────────────────────────────

    // 在 doc 树里找第一个"未处理过且当前确实是 clip base"的 layer。
    // base 的判断：它自己 grouped=false，且 panel 上紧邻它上面那一层 grouped=true。
    // PS DOM 中 layers[0] 是 panel 上最顶层，layers[N-1] 是最底层。
    function findFirstClipBase(parent, failedIds) {
        var arr = parent.layers;
        for (var i = 1; i < arr.length; i++) {
            var self = arr[i];
            if (failedIds && failedIds[self.id]) continue;
            if (!isClipped(self) && isClipped(arr[i - 1])) {
                return self;
            }
        }
        // 同级没找到，递归子组
        for (var j = 0; j < arr.length; j++) {
            if (arr[j].typename === "LayerSet") {
                var found = findFirstClipBase(arr[j], failedIds);
                if (found !== null) return found;
            }
        }
        return null;
    }

    // 用 ActionManager 读 layer 的 group 属性（boolean）——这是 PS 内部对
    // "本层是否 clipping 到下方 base"的标记。在 ArtLayer / LayerSet 上都可读。
    function isClipped(layer) {
        try {
            var ref = new ActionReference();
            ref.putIdentifier(stringIDToTypeID("layer"), layer.id);
            var desc = executeActionGet(ref);
            return desc.getBoolean(stringIDToTypeID("group"));
        } catch (e) {
            return false;
        }
    }

    // 真正执行合并 + 栅格化。返回 true=做了事；false=判定不一致跳过（同 try/catch）
    function mergeAndRasterize(base) {
        // 1. base 是 LayerSet → 先合并成 ArtLayer
        if (base.typename === "LayerSet") {
            base = base.merge(); // 返回新 ArtLayer，原 LayerSet 引用失效
        }

        // 2. 重新定位 base 在 parent.layers 里的 index
        var parent = base.parent;
        var arr = parent.layers;
        var baseIdx = -1;
        for (var i = 0; i < arr.length; i++) {
            if (arr[i] === base) { baseIdx = i; break; }
        }
        if (baseIdx < 0) return false;

        // 3. 找 top clip layer：从 baseIdx-1 往上数连续 grouped=true 的最顶部
        var topClipIdx = baseIdx;
        for (var j = baseIdx - 1; j >= 0; j--) {
            if (isClipped(arr[j])) {
                topClipIdx = j;
            } else {
                break;
            }
        }
        if (topClipIdx === baseIdx) {
            // 没找到 clip layer，说明 base 已不再是 base（可能上轮被改了）
            return false;
        }

        // 4. 从 topClip 开始，每次向下合并一层，共执行 (baseIdx - topClipIdx) 次。
        //    merge() 返回合并结果层；用返回值更新 activeLayer，确保下一次
        //    循环时 doc.activeLayer 一定指向最新的合并结果。
        var count = baseIdx - topClipIdx;
        doc.activeLayer = arr[topClipIdx];
        for (var k = 0; k < count; k++) {
            doc.activeLayer = doc.activeLayer.merge();
        }

        // 5. 循环结束后 activeLayer 就是合并结果。栅格化它残留的 effects（来自 base）
        var merged = doc.activeLayer;
        if (hasEnabledLayerEffects(merged)) {
            rasterizeLayerStyleOfActive();
        }
        return true;
    }

    // 复用 rasterizeLayerStyles / flattenGroupsWithEffects 里的同款判定
    function hasEnabledLayerEffects(layer) {
        try {
            var ref = new ActionReference();
            ref.putIdentifier(stringIDToTypeID("layer"), layer.id);
            var desc = executeActionGet(ref);
            var fxKey = stringIDToTypeID("layerEffects");
            if (!desc.hasKey(fxKey)) return false;
            var fx = desc.getObjectValue(fxKey);
            var fxVisKey = stringIDToTypeID("layerFXVisible");
            if (fx.hasKey(fxVisKey) && fx.getBoolean(fxVisKey) === false) return false;
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

    // 等价菜单 "Layer → Rasterize → Layer Style"
    function rasterizeLayerStyleOfActive() {
        var desc = new ActionDescriptor();
        var ref = new ActionReference();
        ref.putEnumerated(
            stringIDToTypeID("layer"),
            stringIDToTypeID("ordinal"),
            stringIDToTypeID("targetEnum")
        );
        desc.putReference(stringIDToTypeID("null"), ref);
        desc.putEnumerated(
            stringIDToTypeID("what"),
            stringIDToTypeID("rasterizeItem"),
            stringIDToTypeID("layerStyle")
        );
        executeAction(stringIDToTypeID("rasterizeLayer"), desc, DialogModes.NO);
    }
})();
