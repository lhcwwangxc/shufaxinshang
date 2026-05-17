# 墨韵书斋 - 批量删除作品功能 (2026-05-17)

## 功能说明

在作品集详情页，现在可以勾选多个作品，然后批量删除。

### 使用方式

1. 打开任意作品集
2. 每个作品卡片左上角有一个圆形选择按钮（○）
3. 点击选择按钮 → 按钮变为金色实心（✓），卡片出现金色边框，表示已选中
4. 选中任意作品后，顶部操作栏会出现「🗑️ 删除选中(N)」按钮
5. 点击「删除选中」→ 确认后批量删除
6. 点击卡片其他区域（非选择按钮）→ 正常打开预览

### 实现细节

#### index.html 修改
1. **CSS 样式**（`<style>` 标签内）：
   - `.work-item { position:relative; }` — 为选择按钮定位提供参照
   - `.work-select` — 圆形选择按钮样式（绝对定位、左上角、半透明背景）
   - `.work-item.selected .work-select` — 选中状态：金色背景、深色✓
   - `.work-item.selected` — 选中卡片：金色边框 + 金色阴影

2. **HTML**（collectionDetail 的 btn-row）：
   - 添加 `<button id="btnDeleteSelected" style="display:none;">🗑️ 删除选中(<span id="selectedCount">0</span>)</button>`
   - 默认隐藏，只在有作品被选中时显示

#### app.js 修改

1. **App 对象新增属性**：
   ```javascript
   selectedWorkIds: [],  // 存储当前选中的作品 ID 数组
   ```

2. **`loadWorks()` 方法修改**：
   - 每个 work-item 左上角添加 `<div class="work-select">✓</div>`
   - 选择按钮的 onclick：`event.stopPropagation(); App.toggleWorkSelection(id);`
     - `event.stopPropagation()` 阻止冒泡，避免触发卡片的预览点击事件
   - 卡片的 onclick 仍然是 `App.previewWork(id)`（点击卡片其他区域可预览）
   - 根据 `App.selectedWorkIds.includes(w.id)` 决定是否添加 `selected` 类

3. **新增 `toggleWorkSelection(id)` 方法**：
   - 切换指定 id 的选中状态（在 `selectedWorkIds` 数组中添加/移除）
   - 更新对应卡片的 `selected` CSS 类
   - 更新「删除选中」按钮的文本和显示状态

4. **新增 `deleteSelectedWorks()` 方法**：
   - 检查 `selectedWorkIds.length`，为 0 则直接返回
   - 弹出 `confirm()` 确认框，显示要删除的数量
   - 打开 IndexedDB 事务，遍历 `selectedWorkIds` 逐个删除
   - 删除成功后：清空 `selectedWorkIds`、隐藏删除按钮、重新加载作品列表

5. **`openCollection()` 方法修改**：
   - 打开作品集时，清空 `selectedWorkIds = []`
   - 隐藏「删除选中」按钮

6. **`initApp()` 方法修改**：
   - 绑定 `btnDeleteSelected` 的 click 事件，调用 `App.deleteSelectedWorks()`

## 文件变更

| 文件 | 变更内容 |
|------|-----------|
| `index.html` | 添加 CSS 样式、添加「删除选中」按钮 HTML |
| `app.js` | 添加 selectedWorkIds 属性、修改 loadWorks()、新增 toggleWorkSelection()、新增 deleteSelectedWorks()、修改 openCollection()、修改 initApp() |

## 测试建议

1. 打开一个已有作品的作品集
2. 点击某个作品左上角的选择按钮，确认按钮变金色、卡片有金色边框
3. 点击另一个作品的选择按钮，确认「删除选中(2)」按钮出现
4. 点击卡片其他区域（非选择按钮），确认可以正常打开预览
5. 点击「删除选中(2)」，确认弹窗提示正确，删除后列表更新
6. 选中作品后点击「返回」，确认重新打开该作品集时选择状态已清空
