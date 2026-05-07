// Unlock all locked layers/layer groups in current document.
// Traversal rule: if a locked group is encountered, unlock the group first,
// then traverse and unlock its children.
// Hidden layers: if a layer is hidden before unlocking, it is unlocked then
// deleted immediately to prevent it from reappearing after the lock is removed.
#target Photoshop

(function () {
    if (!app.documents.length) return;

    var doc = app.activeDocument;

    function unlockOne(layer) {
        try {
            layer.allLocked = false;
        } catch (e) {}
        try {
            if (layer.pixelsLocked !== undefined) layer.pixelsLocked = false;
        } catch (e2) {}
        try {
            if (layer.positionLocked !== undefined) layer.positionLocked = false;
        } catch (e3) {}
        try {
            if (layer.transparentPixelsLocked !== undefined) layer.transparentPixelsLocked = false;
        } catch (e4) {}
    }

    function traverseAndProcess(container) {
        // Iterate backwards so deletion doesn't shift indices of unvisited layers.
        for (var i = container.layers.length - 1; i >= 0; i--) {
            var layer = container.layers[i];
            var hidden = !layer.visible;

            if (layer.typename === "LayerSet") {
                if (hidden) {
                    // Hidden group: unlock + delete entirely (skip traversal into children).
                    unlockOne(layer);
                    try { layer.remove(); } catch (e) {}
                } else {
                    // Visible group: unlock first, then traverse children.
                    unlockOne(layer);
                    traverseAndProcess(layer);
                }
            } else {
                if (hidden) {
                    // Hidden regular layer: unlock + delete.
                    unlockOne(layer);
                    try { layer.remove(); } catch (e) {}
                } else {
                    unlockOne(layer);
                }
            }
        }
    }

    // Top-level traversal from active document.
    traverseAndProcess(doc);
})();
