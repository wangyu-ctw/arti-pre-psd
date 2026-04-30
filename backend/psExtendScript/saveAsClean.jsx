// saveAsClean.jsx
// ────────────────────────────────────────────────────────────────────────
// 把当前活动文档另存为 [原文件名]_clean.psd，落到原文件所在目录。
//
// 双重身份：
//   A. 子流程被 AppleScript `do javascript file` 调用时：
//      末尾 IIFE 的返回值（输出路径字符串）直接成为 do javascript 的返回值，
//      宿主拿到这个 path 即可。**不弹任何 alert**（弹了会卡住自动化流程）。
//   B. 用户从 PS 菜单 File → Scripts → Browse... 手动跑时：
//      仍能正常运行，只是不会弹"已保存到..."提示。需要看保存位置可手动用
//      Finder 打开原文件目录确认。
//
// 行为细节：
//   - 输出路径：原文件目录 / <原 stem>_clean.psd
//     例：/path/U613.psd → /path/U613_clean.psd
//   - 文件已存在时自动加 _1 / _2 后缀避免覆盖
//   - asCopy=true：保留 activeDocument 仍是原文件，不切换到新文件，
//     方便 AppleScript 之后 `close current document saving no` 关掉原文件。
//   - 新文档没有 path（从未保存过、从相机导入等）时回落到 ~/Desktop/
// ────────────────────────────────────────────────────────────────────────

#target photoshop

// 末尾 IIFE 表达式即文件返回值；AppleScript `do javascript file` 拿到它。
(function () {
    if (app.documents.length === 0) {
        return ""; // 让宿主自己判定空字符串 = 没文档
    }

    var doc = app.activeDocument;

    var dir, baseName;
    try {
        var origFile = doc.fullName;
        dir = origFile.parent;
        baseName = origFile.name;
    } catch (e) {
        // 文档没有磁盘路径（新建未保存）—— 落到桌面，文件名用文档 name
        dir = Folder.desktop;
        baseName = doc.name;
    }

    var stem = baseName.replace(/\.psd$/i, "").replace(/\.psb$/i, "");
    var outFile = uniqueFile(dir, stem + "_clean", "psd");

    var opts = new PhotoshopSaveOptions();
    opts.embedColorProfile = true;
    opts.alphaChannels = true;
    opts.layers = true;
    opts.spotColors = true;
    opts.annotations = true;

    // 第三个参数 asCopy=true：另存为副本，不改 activeDocument 的路径
    doc.saveAs(outFile, opts, true, Extension.LOWERCASE);

    // 返回字符串路径给 AppleScript / 宿主自动化
    return outFile.fsName;

    // ─── helpers ────────────────────────────────────────────────────

    function uniqueFile(dir, stem, ext) {
        var candidate = new File(dir + "/" + stem + "." + ext);
        if (!candidate.exists) return candidate;
        var n = 1;
        while (true) {
            var c = new File(dir + "/" + stem + "_" + n + "." + ext);
            if (!c.exists) return c;
            n++;
        }
    }
})();
