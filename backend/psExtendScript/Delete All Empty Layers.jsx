// Copyright: 2018 Adobe Systems, Inc. All rights reserved.
// Completely rewritten by Jaroslav Bereza <http://bereza.cz> previous script written by Naoki Hada
// Visit http://bereza.cz/ps for more scripts
/*
@@@BUILDINFO@@@ Delete All Empty Layers.jsx 2.0.0.0
*/
// ────────────────────────────────────────────────────────────────────────
// 本仓库 fork 修改（在 Adobe 原版基础上扩展）：
//
// 1. "有效不可见"图层强制删除（含 locked、含 0 透明度）：
//    · 任一图层（普通图层 / 图层组）的 effectiveVisible = false 一律删，
//      effectiveVisible = (自己 visible AND opacity > 0) AND 所有祖先组都
//      满足同样条件。父组隐藏 / 父组 opacity=0 自动传播给所有后代。
//    · "强制删除"含 locked 图层：删前先 applyLocking 解锁，避免 PS 拒绝删。
//      这是与原脚本"locked 一律保护"行为的有意背离。
//    · 原脚本"空像素 / 空文字层"判定保持不变，仍受 locked 保护。
//
// 2. clipping mask 级联删除：当 base 图层被标记删除时，把上方所有连续
//    clipping=true 的图层一起删（强度跟随 base：base 走 hidden 路径则 clipped
//    也 hidden 强制删，base 走 empty 路径则 clipped 也受 locked 保护）。
//    原脚本只是 hide 这些 clipped layer 防止飘移，新策略直接连根拔起。
//
// 实现位置：搜索 "// FORK:" 注释定位增量逻辑。
// ────────────────────────────────────────────────────────────────────────
/*
// BEGIN__HARVEST_EXCEPTION_ZSTRING
<javascriptresource>
<name>$$$/JavaScripts/DeleteAllEmptyLayers/Menu=Delete All Empty Layers</name>
<category>Delete</category>
<enableinfo>true</enableinfo>
<eventid>a0754df2-9c60-4b64-a940-6a2bb1102652</eventid>
<terminology><![CDATA[<< /Version 1 
                         /Events << 
                          /a0754df2-9c60-4b64-a940-6a2bb1102652 [($$$/JavaScripts/DeleteAllEmptyLayers/Menu=Delete All Empty Layers) /noDirectParam <<
                          >>] 
                         >> 
                      >> ]]></terminology>
</javascriptresource>
// END__HARVEST_EXCEPTION_ZSTRING
*/
// enable double clicking from the 
// Macintosh Finder or the Windows Explorer
#target Photoshop
// debug level: 0-2 (0:disable, 1:break on error, 2:break at beginning)
// $.level = 2;
// debugger; // launch debugger on next line
/*
    KNOWN ISSUES:
    - if you make set visibility of clipped masks to hidden and you run "undo" command then these layers stay hidden
*/
/////////////////////////
// SETUP
/////////////////////////
// all the strings that need localized
var strDeleteAllEmptyLayersHistoryStepName = localize("$$$/JavaScripts/DeleteAllEmptyLayers/Menu=Delete All Empty Layers");
/////////////////////////
// MAIN
/////////////////////////
var doc;  // remember the document. But we do it later because we first need make sure that there are documents
var numberOfLayers;
var backgroundCounter;
var isCancelled = false;
// caching precalculated typeID numbers for saving a bit miliseconds and nicer code
var TID = {
    property: charIDToTypeID("Prpr"),
    bounds: stringIDToTypeID("bounds"),
    layer: charIDToTypeID("Lyr "),
    top: stringIDToTypeID('top'),
    bottom: stringIDToTypeID('bottom'),
    left: stringIDToTypeID('left'),
    right: stringIDToTypeID('right'),
    layerLocking: stringIDToTypeID("layerLocking"),
    protectAll: stringIDToTypeID('protectAll'),
    layerID: stringIDToTypeID("layerID"),
    group: stringIDToTypeID("group"),
    layerSection: stringIDToTypeID("layerSection"),
    textKey: stringIDToTypeID("textKey"),
    idNull: charIDToTypeID("null"),
    idDelete: charIDToTypeID("Dlt "),
    document: charIDToTypeID("Dcmn"),
    ordinal: charIDToTypeID("Ordn"),
    target: charIDToTypeID("Trgt"),
    hide: charIDToTypeID("Hd  "),
    application: charIDToTypeID("capp"),
    set: charIDToTypeID("setd"),
    to: charIDToTypeID("T   "),
    playbackOptions: stringIDToTypeID("playbackOptions"),
    hasBackgroundLayer: stringIDToTypeID("hasBackgroundLayer"),
    performance: stringIDToTypeID("performance"),
    layerSectionEnd: stringIDToTypeID("layerSectionEnd"),
    layerSectionStart: stringIDToTypeID("layerSectionStart"),
    layerSectionContent: stringIDToTypeID("layerSectionContent"),
    numberOfLayers: stringIDToTypeID("numberOfLayers"),
    accelerated: stringIDToTypeID("accelerated"),
    visible: stringIDToTypeID("visible"), // FORK: "有效可见性"判定
    opacity: stringIDToTypeID("opacity")  // FORK: 0 透明度等同隐藏
};
main();
// Record the script in the Actions palette when recording an action
try {
    var playbackDescription = new ActionDescriptor();
    var playbackReference = new ActionReference();
    playbackReference.putEnumerated(TID.document, TID.ordinal, TID.target);
    playbackDescription.putReference(TID.idNull, playbackReference);
    app.playbackDisplayDialogs = DialogModes.NO;
    app.playbackParameters = playbackDescription;
} catch (e) { /* do nothing */ }
isCancelled ? 'cancel' : undefined; // quit, returning 'cancel' (don't localize) makes the actions palette not record our script
/////////////////////////
// FUNCTIONS
/////////////////////////
///////////////////////////////////////////////////////////////////////////////
// Function: main
// Usage: container function to hold all the working code that generates history states
// Input: <none> Must have an open document
// Return: <none>
///////////////////////////////////////////////////////////////////////////////
function main() {
    // there must be document
    // Document must have at least one layer so we don't need rum script if there is only one layer
    if (app.documents.length > 0) {
        numberOfLayers = getNumberOfLayers();
        backgroundCounter = getBackgroundLayerCounter();
        if(numberOfLayers + backgroundCounter > 1){
            try {
                doc = app.activeDocument;
                doc.suspendHistory(strDeleteAllEmptyLayersHistoryStepName, "runTask()");
            } catch (e) {
                isCancelled = true;
            }
        }
    }
}
function runTask() {
    acceleratePlayback();
    var deleteLayersList = [];
    var hideLayersList = [];
    var unlockBeforeDeleteList = []; // FORK: 删之前要先 unlock 的 layerID 列表（locked + hidden）
    var layers = new Array(numberOfLayers); // we know array lenght so we can reserve fixed space in memory
    var maxNestedLevels = 0;
    // We want to avoid DOM code here because it can be slow if document has a lot layers and nested layerSets. So we will use Action Manager code.
    for (var layerIndex = numberOfLayers, stepsInside = 0; layerIndex > 0; layerIndex--) { // stepsInside = how deep I am in folder structure
        var locked = getIsLocked(layerIndex);
        var layerType = getLayerType(layerIndex);
        var visible = getIsVisible(layerIndex); // FORK: 该 record 自己的 visible
        var opacity = getOpacity(layerIndex);   // FORK: 0-255，0 视为隐藏
        var shouldRemove = false;
        var nestedLevels;
        // NOT layerSet
        if (layerType === 'layer') {
            nestedLevels = stepsInside + 1;
            shouldRemove = ((hasZeroDimensions(layerIndex) || getIsEmptyTextLayer(layerIndex)) && !locked);
        }
        // layerSet end - closing (invisible) layer
        else if (layerType === 'endOfLayerSet') {
            nestedLevels = stepsInside;
            stepsInside--;
        }
        // layerSet start - opening layer
        else if (layerType === 'startOfLayerSet') {
            stepsInside++;
            nestedLevels = stepsInside;
            shouldRemove = true; // we will check it later properly
        }
        if (nestedLevels > maxNestedLevels) {
            maxNestedLevels = nestedLevels;
        }
        var layerInfo = {
            nestedLevels: nestedLevels,
            layerType: layerType,
            itemIndex: layerIndex,
            itemID: getLayerId(layerIndex),
            remove: shouldRemove,
            locked: locked,
            visible: visible,        // FORK: 自己的 visible flag
            opacity: opacity,        // FORK: 自己的 opacity 0-255
            effectiveVisible: true,  // FORK: 含祖先链的最终可见性，computeEffectiveVisibility 填
            isClipped: getIsClipped(layerIndex)
        };
        layers[numberOfLayers - layerIndex] = layerInfo;
    }
    // FORK: 算每个 record 的"有效可见性"——自己 visible AND 所有祖先 group visible。
    //   计算之后 effectiveVisible=false 的 record 会在 addLayersToDeleteLayersList
    //   阶段被强制纳入删除列表（且无视 locked，必要时先 unlock）。
    computeEffectiveVisibility();
    resolveLayerSetsWithContent();
    resolveChildsOfLockedLayerSets();
    resolveClippingMasks();
    addLayersToDeleteLayersList();
    if (deleteLayersList && deleteLayersList.length) { // if there is something to delete
        // FORK: 删之前先把所有"因隐藏要删但 locked"的图层解锁，否则 PS 拒绝删。
        if (unlockBeforeDeleteList && unlockBeforeDeleteList.length) {
            runUnlockLayers(unlockBeforeDeleteList);
        }
        // if layer which we want delete has clipping mask, then we hide clipping mask layers
        if (hideLayersList && hideLayersList.length) {runHideLayers(hideLayersList);}
        runDeleteLayers(deleteLayersList);
    }
    
    // we traverse layers from most nested levels to more shallow levels
    // so we can tell parent layerSets that we don't want remove them because they will have content
    // we traverse all layers in document for each level. Maximum nested levels is 10 and maximum layers is 8000. This means 80 000 cycles in extreme case.
    function resolveLayerSetsWithContent(){
        for (var j = 1; j < maxNestedLevels; maxNestedLevels--) {
            for (var i = 0; i < numberOfLayers; i++) {
                var layer = layers[i];
                
                if (layer.nestedLevels === maxNestedLevels) {
                    if(
                        // don't remove parent layerSet if we want keep its content
                        (layer.layerType === 'layer' && !layer.remove) ||
                        // or don't remove locked parent group or don't remove parent folder if children folder shouldn't be deleted
                        ((layer.locked || !layer.remove) && layer.layerType === 'startOfLayerSet')
                    ){ 
                        var parrentLayerSet = layers[getParentLayerSet(i)];
                        // FORK: 父组若 effectiveVisible=false（自己或上级 hidden），不被反推保留
                        if (parrentLayerSet.effectiveVisible) {
                            parrentLayerSet.remove = false;
                        }
                    }
                }
            }
        }
    }
    
    // FORK: 顺序遍历 layers（layers[0] 是 panel 最顶层 record），用一个
    //   "祖先组是否显示"栈算每个 record 的 effectiveVisible = (自己 visible
    //   AND 自己 opacity > 0) AND 所有祖先组同样满足。
    //   "opacity > 0" 跟 visible 同等待遇——0 透明度的图层视觉上完全不可见，
    //   按用户的"强硬策略"应该被强制删（含作为剪切蒙版底图的情况）。
    //   后续 addLayersToDeleteLayersList 据此把 effectiveVisible=false 的
    //   record 强制加入删除列表（无视 locked）。
    function computeEffectiveVisibility() {
        var ancestorStack = []; // 每一项是某层祖先 group 是否"显示"（visible AND opacity>0）
        for (var j = 0; j < numberOfLayers; j++) {
            var layer = layers[j];
            // 自身"显示"：visible 且 opacity 大于 0
            var selfDisplayed = layer.visible && layer.opacity > 0;
            // 祖先链是否全显示
            var ancestorAllVisible = true;
            for (var k = 0; k < ancestorStack.length; k++) {
                if (!ancestorStack[k]) { ancestorAllVisible = false; break; }
            }
            layer.effectiveVisible = ancestorAllVisible && selfDisplayed;

            if (layer.layerType === 'startOfLayerSet') {
                // 进入组：把组自己的"显示状态"推入栈
                ancestorStack.push(selfDisplayed);
            } else if (layer.layerType === 'endOfLayerSet') {
                ancestorStack.pop();
            }
        }
    }

    // excludes all childs from delete list if parent layerSet is locked
    function resolveChildsOfLockedLayerSets() {
        for (var j = 0; j < numberOfLayers; j++) { 
            //var layer = layers[j];
            if (layers[j].locked && layers[j].layerType === 'startOfLayerSet') {
                // FORK: locked 但 hidden 的 group 不保护 children——hidden 强制删
                if (!layers[j].effectiveVisible) continue;
                var initialNestedLevel = layers[j].nestedLevels;
                j++;
                while (initialNestedLevel < layers[j].nestedLevels) {
                    // FORK: hidden child 不被 locked 父组保护
                    if (layers[j].effectiveVisible) {
                        layers[j].remove = false;
                    }
                    j++;
                }
            }
        }
    }
    // FORK: cascade clipped layers when base is being removed
    //   原 PS 脚本只 hide 上方的 clipped layers（避免它们飘到错误的 base 上），
    //   但 layer 仍残留在产物里。新需求"策略需要强硬"：base 要被删时把上方
    //   所有连续 clipping=true 的 layer 一起标 remove，跟 base 同等强度——
    //     · base 走 hidden 强制路径（!effectiveVisible）→ clipped 也强制
    //       hidden 路径，删前会自动 unlock
    //     · base 走 empty 路径（remove=true 但 effectiveVisible=true）→
    //       clipped 受 locked 保护
    //
    //   触发条件 baseWillBeRemoved = base.remove OR !base.effectiveVisible：
    //     · base.remove=true 来源：空像素 / 空文字层 / startOfLayerSet 默认值
    //     · !base.effectiveVisible 来源：自己 visible=false / opacity=0 /
    //       任一祖先组 hidden 或 opacity=0
    //     **第二种情况 base.remove 字段未被改，仅在 addLayersToDeleteLayersList
    //       阶段通过 !effectiveVisible 强制加入删除列表**——所以 cascade
    //       必须同时检查这两个条件，否则会漏掉"hidden base"的级联场景
    //       （早期版本只看 base.remove 导致 hidden base 的 clipped 没被删）。
    //
    //   layers 数组顺序：layers[0] 是 panel 最顶层；clipped layers 在 base
    //   panel 上方 = 数组 index 更小。从 base 向 i-1 方向数连续 isClipped=true
    //   即 base 的整个 clip stack。
    function resolveClippingMasks(){
        for (var i = 0; i < numberOfLayers; i++) {
            var base = layers[i];
            // endOfLayerSet 永远不是 base，跳过
            if (base.layerType === 'endOfLayerSet') continue;
            // base 要被删的两种途径之一
            var baseWillBeRemoved = base.remove || !base.effectiveVisible;
            if (!baseWillBeRemoved) continue;
            // 顺数组向上扫，直到遇到第一个非 clipping
            for (var k = i - 1; k >= 0; k--) {
                if (!layers[k].isClipped) break;
                layers[k].remove = true;
                // 同强度：base 走 hidden 强制路径 → clipped 也走（强制 unlock）
                if (!base.effectiveVisible) {
                    layers[k].effectiveVisible = false;
                }
            }
        }
    }
    // just move layer from one list to another list
    function addLayersToDeleteLayersList() {
        for (var j = 0; j < numberOfLayers; j++) {
            var layer = layers[j];
            // FORK: endOfLayerSet 是 PS 内部的组关闭标记，删 startOfLayerSet 时
            //   会自动连带删除，单独 putIdentifier 反而可能失败/产生噪声，跳过。
            if (layer.layerType === 'endOfLayerSet') continue;
            // FORK: effectiveVisible=false（自己或父组 hidden）→ 强制删，无视 locked。
            //   locked 的 hidden 图层先记入 unlockBeforeDeleteList，删之前会先解锁。
            if (!layer.effectiveVisible) {
                deleteLayersList.push(layer.itemID);
                if (layer.locked) {
                    unlockBeforeDeleteList.push(layer.itemID);
                }
                continue;
            }
            // 原逻辑：仅删非 locked 且 remove=true 的（空图层 / 空文字层等）
            if (layer.remove && !layer.locked) {
                deleteLayersList.push(layer.itemID);
            }
        }
    }
    // this will find parental layerSet for current layer or layerSet
    function getParentLayerSet(p) { 
        for (var i = p - 1; i > 0; i--) {
            if (layers[i].nestedLevels === layers[p].nestedLevels - 1) {
                return i;
            }
        }
        return 0;
    }
}
//////////////////////////////
// READ DOCUMENT PROPERTIES
//////////////////////////////
///////////////////////////////////////////////////////////////////////////////
// Function: hasZeroDimensions
// Usage: we read layer dimensions and if are zero then layer has zero visible pixels (they might be hidden with vector or bitmap mask)
// Input: index of desired layer
// Return: Boolean
///////////////////////////////////////////////////////////////////////////////
function hasZeroDimensions(index) {
    var desc = getLayerPropertyDescriptor(index, TID.bounds);
    var bounds = desc.getObjectValue(TID.bounds);
    var left = bounds.getDouble(TID.left);
    var right = bounds.getDouble(TID.right);
    var top = bounds.getDouble(TID.top);
    var bottom = bounds.getDouble(TID.bottom);
    var result = (left === right) && (top === bottom);
    return result;
}
///////////////////////////////////////////////////////////////////////////////
// Function: getIsClipped
// Usage: we don't want remove locked layers. There are multiple kinds of locks. We need only "protectAll"
// Input: index of desired layer
// Return: Boolean
///////////////////////////////////////////////////////////////////////////////
function getIsLocked(index) {
    var desc = getLayerPropertyDescriptor(index, TID.layerLocking);
    var descLocking = desc.getObjectValue(TID.layerLocking);
    var locked = descLocking.getBoolean(TID.protectAll);
    return locked;
}
///////////////////////////////////////////////////////////////////////////////
// Function: getIsClipped
// Usage: returns ID of layer so we can target layer no matter of layer position in layers panel
// Input: index of desired layer
// Return: Integer
///////////////////////////////////////////////////////////////////////////////
function getLayerId(index) {
    var desc = getLayerPropertyDescriptor(index, TID.layerID);
    var id = desc.getInteger(TID.layerID);
    return id;
}
///////////////////////////////////////////////////////////////////////////////
// Function: getIsClipped
// Usage: returns true if layer is clipping mask
// Input: index of desired layer
// Return: Boolean
///////////////////////////////////////////////////////////////////////////////
function getIsClipped(index) {
    var desc = getLayerPropertyDescriptor(index, TID.group);
    var group = desc.getBoolean(TID.group);
    return group;
}
///////////////////////////////////////////////////////////////////////////////
// FORK: getIsVisible
// Usage: 读取该 record 的 visible（图层 / 图层组 / sectionEnd 都有此属性）
// Input: index of desired layer
// Return: Boolean
///////////////////////////////////////////////////////////////////////////////
function getIsVisible(index) {
    var desc = getLayerPropertyDescriptor(index, TID.visible);
    return desc.getBoolean(TID.visible);
}
///////////////////////////////////////////////////////////////////////////////
// FORK: getOpacity
// Usage: 读取该 record 的 opacity（0-255 整数）。endOfLayerSet 上读不到时
//        try/catch 兜底返回 255（不影响后续判定，因为 endOfLayerSet 不参与
//        删除决策）。
// Input: index of desired layer
// Return: Integer 0..255
///////////////////////////////////////////////////////////////////////////////
function getOpacity(index) {
    try {
        var desc = getLayerPropertyDescriptor(index, TID.opacity);
        return desc.getInteger(TID.opacity);
    } catch (e) {
        return 255;
    }
}
///////////////////////////////////////////////////////////////////////////////
// Function: getLayerType
// Usage: returns type of layer
// Input: index of desired layer
// Return: String
///////////////////////////////////////////////////////////////////////////////
function getLayerType(index) {
    var desc = getLayerPropertyDescriptor(index, TID.layerSection);
    var type = desc.getEnumerationValue(TID.layerSection);
    switch (type) {
        case TID.layerSectionEnd:
            return 'endOfLayerSet';
        case TID.layerSectionStart:
            return 'startOfLayerSet';
        case TID.layerSectionContent:
            return 'layer';
        default:
            return undefined;
    }
}
///////////////////////////////////////////////////////////////////////////////
// Function: getNumberOfLayers
// Usage: returns number of all layers in document
// Input: <none> Must have an open document
// Return: Integer
///////////////////////////////////////////////////////////////////////////////
function getNumberOfLayers() {
    var desc = getDocumentPropertyDescriptor(TID.numberOfLayers);
    var numberOfLayers = desc.getInteger(TID.numberOfLayers);
    return numberOfLayers;
}
///////////////////////////////////////////////////////////////////////////////
// Function: getIsEmptyTextLayer
// Usage: returns number of all layers in document
// Input: index of desired layer
// Return: Boolean
///////////////////////////////////////////////////////////////////////////////
function getIsEmptyTextLayer(index) {
    var textKey = getLayerPropertyDescriptor(index, TID.textKey);
    
    var isTextLayer = textKey.hasKey(TID.textKey);
    if (!isTextLayer) {
        return false;
    }
    var contentString = textKey.getObjectValue(TID.textKey).getString(TID.textKey);
    var result = (contentString === "");
    return result;
}
///////////////////////////////////////////////////////////////////////////////
// Function: getBackgroundLayerCounter
// Usage: returns if document has background layer
// Input: <none> Must have an open document
// Return: 1 or 0
///////////////////////////////////////////////////////////////////////////////
function getBackgroundLayerCounter() {
    var desc = getDocumentPropertyDescriptor(TID.hasBackgroundLayer);
    var result = Number(desc.getBoolean(TID.hasBackgroundLayer));
    return result;
}
/////////////
// UTILITY
/////////////
///////////////////////////////////////////////////////////////////////////////
// Function: getLayerPropertyDescriptor
// Usage: shortcut helper function which return info about layer property
// Input: Index of desired layer, typeID of desired property
// Return: ActionDescriptor
///////////////////////////////////////////////////////////////////////////////
function getLayerPropertyDescriptor(index, property) {
    var ref = new ActionReference();
    ref.putProperty(TID.property, property);
    ref.putIndex(TID.layer, index);
    var desc = executeActionGet(ref);
    return desc;
}
///////////////////////////////////////////////////////////////////////////////
// Function: getDocumentPropertyDescriptor
// Usage: shortcut helper function which return info about current document property
// Input: TypeID of desired property
// Return: ActionDescriptor
///////////////////////////////////////////////////////////////////////////////
function getDocumentPropertyDescriptor(property) {
    var ref = new ActionReference();
    ref.putProperty(TID.property, property);
    ref.putEnumerated(TID.document, TID.ordinal, TID.target);
    var desc = executeActionGet(ref);
    return desc;
}
///////////////
// ACTIONS
///////////////
///////////////////////////////////////////////////////////////////////////////
// FORK: runUnlockLayers
// Usage: 把传入 layerID 列表里的图层全部"完全解锁"——applyLocking + protectNone=true
//        等价于把 layer locking 面板全部置 off。在删除被隐藏的 locked 图层之前调用。
// Input: Array of layerIDs
// Return: undefined
///////////////////////////////////////////////////////////////////////////////
function runUnlockLayers(idList) {
    var idApplyLocking = stringIDToTypeID("applyLocking");
    var idProtectNone = stringIDToTypeID("protectNone");
    for (var i = 0; i < idList.length; i++) {
        try {
            var desc = new ActionDescriptor();
            var ref = new ActionReference();
            ref.putIdentifier(TID.layer, idList[i]);
            desc.putReference(TID.idNull, ref);
            var lockingDesc = new ActionDescriptor();
            lockingDesc.putBoolean(idProtectNone, true);
            desc.putObject(TID.to, TID.layerLocking, lockingDesc);
            executeAction(idApplyLocking, desc, DialogModes.NO);
        } catch (e) {
            // 解锁失败就跳过，让后续 delete 的 try/catch 去兜底
        }
    }
}
///////////////////////////////////////////////////////////////////////////////
// Function: runHideLayers
// Usage: sets visibility of multiple layers to hidden
// Input: Array of layerIndexes
// Return: undefined
///////////////////////////////////////////////////////////////////////////////
function runHideLayers(hideLayersList) {
    var desc = new ActionDescriptor();
    var list = new ActionList();
    for (var i = 0, len = hideLayersList.length; i < len; i++) {
        var ref = new ActionReference();
        ref.putIndex(TID.layer, hideLayersList[i]);
        list.putReference(ref);
    }
    desc.putList(TID.idNull, list);
    executeAction(TID.hide, desc, DialogModes.NO);
}
///////////////////////////////////////////////////////////////////////////////
// Function: runDeleteLayers
// Usage: deletes multiple layers one by one accoring layerID
// Input: Array of layerIDs
// Return: undefined
///////////////////////////////////////////////////////////////////////////////
function runDeleteLayers (list) {
    var desc = new ActionDescriptor();
    var layerRef = new ActionReference();
    for (var i = list.length - 1, len = i; i >= 0; i--) {
        layerRef.putIdentifier(TID.layer, list[i]);
    }
    desc.putReference(TID.idNull, layerRef);
    // "Try" because document must have at least one layer ...what if all layers would be empty?
    // And single layerSet always has 2 layers so it's a bit complicated
    try{
        executeAction(TID.idDelete, desc, DialogModes.NO);
    }catch(e){
        runDeleteLayersFallBack(list);
    }
}
function runDeleteLayersFallBack(list) {
    for (var i = list.length - 1, len = i; i >= 0; i--) {
        var desc = new ActionDescriptor();
        var layerRef = new ActionReference();
        layerRef.putIdentifier(TID.layer, list[i]);
        desc.putReference(TID.idNull, layerRef);
        // Try because document must have at least one layer ...what if all layers would be empty?
        // And single layerSet always has 2 layers so it's a bit complicated
        try{
            executeAction(TID.idDelete, desc, DialogModes.NO);
        }catch(e){
            /* do nothing */
        }
    }
}
///////////////////////////////////////////////////////////////////////////////
// Function: acceleratePlayback
// Usage: in action preferences can be set delay between each action so we make sure that there is no delay
// Input: <none>
// Return: undefined
///////////////////////////////////////////////////////////////////////////////
function acceleratePlayback() {
    var desc = new ActionDescriptor();
    var ref = new ActionReference();
    var desc2 = new ActionDescriptor();
    ref.putProperty(TID.property, TID.playbackOptions);
    ref.putEnumerated(TID.application, TID.ordinal, TID.target);
    desc.putReference(TID.idNull, ref);
    desc2.putEnumerated(TID.performance, TID.performance, TID.accelerated);
    desc.putObject(TID.to, TID.playbackOptions, desc2);
    executeAction(TID.set, desc, DialogModes.NO);
}
// End Delete All Empty Layers.jsx
