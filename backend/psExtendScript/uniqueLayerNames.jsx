// uniqueLayerNames.jsx
// ────────────────────────────────────────────────────────────────────────
// 整份文档范围内：图层（ArtLayer）与图层组（LayerSet）共享同一套名字空间，
// 保证任意两个条目的 name 互不相同。出现重名时，后遍历到的改名为 base_2、base_3…
//（若该名仍被占用则继续递增），先出现的保留原名。
//
// 遍历顺序：自顶向下、深度优先（与图层面板由上至下、组内再由上至下一致）。
// ────────────────────────────────────────────────────────────────────────

#target photoshop

(function () {
    if (app.documents.length === 0) {
        return "no document";
    }

    var doc = app.activeDocument;

    /** @param {Layer} lyr @param {string} newNm */
    function renameSafe(lyr, newNm) {
        try {
            if (lyr.allLocked) {
                lyr.allLocked = false;
            }
            lyr.name = newNm;
            return true;
        } catch (e) {
            return false;
        }
    }

    /** 前序深度优先收集所有 ArtLayer / LayerSet */
    function collect(container, out) {
        var ls = container.layers;
        for (var i = 0; i < ls.length; i++) {
            var lyr = ls[i];
            out.push(lyr);
            if (lyr.typename === "LayerSet") {
                collect(lyr, out);
            }
        }
    }

    var items = [];
    collect(doc, items);

    /** 已占用的名字（含未改名的首次出现） */
    var used = {};
    var renamed = 0;

    for (var j = 0; j < items.length; j++) {
        var L = items[j];
        var nm = L.name;

        if (!used[nm]) {
            used[nm] = true;
            continue;
        }

        var k = 2;
        var applied = false;
        while (k < 10000 && !applied) {
            var candidate = nm + "_" + k;
            k++;
            if (used[candidate]) {
                continue;
            }
            if (renameSafe(L, candidate)) {
                used[candidate] = true;
                renamed++;
                applied = true;
            }
        }
    }

    return "renamed=" + renamed;
})();
