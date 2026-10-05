<script setup lang="ts">
import { computed, ref } from "vue";
import type { ConversationMessage } from "../../shared/conversations";
import {
  displayText,
  textChunk,
  formatConversationTime,
  roleLabels,
  partLabels,
} from "./presentation";
const props = defineProps<{ message: ConversationMessage; index: number }>();
const offsets = ref(new Map<number, number>());
const partPage = ref(0);
const chunkSize = 12000;
const parts = computed(() =>
  props.message.parts
    .slice(partPage.value * 4, partPage.value * 4 + 4)
    .map((part, localIndex) => {
      const index = partPage.value * 4 + localIndex;
      const offset = offsets.value.get(index) ?? 0;
      const chunk = textChunk(part.text, offset, chunkSize);
      return {
        ...part,
        index,
        offset: chunk.start,
        end: chunk.end,
        display: displayText(chunk.text, chunk.text.length),
        more: chunk.more,
      };
    }),
);
function moveText(index: number, offset: number) {
  const next = new Map(offsets.value);
  next.set(index, Math.max(0, offset));
  offsets.value = next;
}
</script>
<template>
  <article
    class="conversation-message"
    :class="`message-role-${message.role}`"
    :aria-label="`${roleLabels[message.role] ?? '未知角色'}，第 ${index} 条展示记录`"
  >
    <header class="conversation-message-heading">
      <strong>{{ roleLabels[message.role] ?? "未知角色" }}</strong
      ><span class="conversation-message-number">#{{ index }}</span
      ><time v-if="message.timestamp" :datetime="message.timestamp">{{
        formatConversationTime(message.timestamp)
      }}</time
      ><span v-else>时间未记录</span>
    </header>
    <p v-if="message.source" class="conversation-message-source">
      {{ message.source.label }}
    </p>
    <p v-if="message.continuation" class="conversation-truncation">
      消息分段 · 内容段 {{ message.continuation.partIndex + 1 }} · 从第
      {{ message.continuation.offset + 1 }} 个字符继续<span
        v-if="message.continuation.hasMore"
        >，后续内容见下一页</span
      >。展示序号不代表原生消息数量。
    </p>
    <div
      v-for="part in parts"
      :key="part.index"
      class="conversation-part"
      :class="`part-${part.type}`"
    >
      <div v-if="part.type !== 'text'" class="conversation-part-kind">
        {{ partLabels[part.type] ?? "未知内容" }}
      </div>
      <template v-if="part.type === 'attachment'"
        ><p class="conversation-attachment">
          {{ part.text.slice(part.offset, part.end) || "此附件未加载。" }}
        </p>
        <small>附件仅显示说明，不加载本地文件或外部媒体。</small></template
      >
      <details
        v-else-if="
          part.type === 'tool-call' ||
          part.type === 'tool-result' ||
          part.type === 'thinking'
        "
        class="conversation-tool-detail"
      >
        <summary>
          {{ part.text.slice(0, 160).replace(/\s+/g, " ") || "查看记录"
          }}<span>展开只读内容</span>
        </summary>
        <template
          v-for="(block, blockIndex) in part.display.blocks"
          :key="blockIndex"
        >
          <pre
            v-if="block.kind === 'code'"
            class="conversation-code"
          ><span v-if="block.language" class="conversation-code-language">{{ block.language }}</span><code>{{ block.text }}</code></pre>
          <p v-else class="conversation-text">{{ block.text }}</p></template
        >
      </details>
      <template v-else
        ><template
          v-for="(block, blockIndex) in part.display.blocks"
          :key="blockIndex"
        >
          <pre
            v-if="block.kind === 'code'"
            class="conversation-code"
          ><span v-if="block.language" class="conversation-code-language">{{ block.language }}</span><code>{{ block.text }}</code></pre>
          <p v-else class="conversation-text">{{ block.text }}</p></template
        ></template
      >
      <div v-if="part.offset || part.more" class="conversation-text-pagination">
        <button
          class="text-button"
          :disabled="part.offset === 0"
          @click="moveText(part.index, part.offset - chunkSize)"
        >
          前一段内容</button
        ><span
          >{{ (part.offset + 1).toLocaleString("zh-CN") }}–{{
            part.end.toLocaleString("zh-CN")
          }}
          / {{ part.text.length.toLocaleString("zh-CN") }} 字符</span
        ><button
          class="text-button"
          :disabled="!part.more"
          @click="moveText(part.index, part.end)"
        >
          继续此段内容
        </button>
      </div>
    </div>
    <div v-if="message.parts.length > 4" class="conversation-text-pagination">
      <button
        class="text-button"
        :disabled="partPage === 0"
        @click="partPage--"
      >
        前组内容段</button
      ><span
        >内容段 {{ partPage * 4 + 1 }}–{{
          Math.min(partPage * 4 + 4, message.parts.length)
        }}
        / {{ message.parts.length }}</span
      ><button
        class="text-button"
        :disabled="(partPage + 1) * 4 >= message.parts.length"
        @click="partPage++"
      >
        后组内容段
      </button>
    </div>
    <p v-if="!message.parts.length" class="conversation-truncation">
      此消息没有可显示的文本。
    </p>
  </article>
</template>
