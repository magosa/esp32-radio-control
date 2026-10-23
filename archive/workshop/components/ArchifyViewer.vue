<script setup lang="ts">
withDefaults(
  defineProps<{
    src: string
    title?: string
    height?: string
  }>(),
  {
    title: 'Archify Diagram',
    height: '410px',
  }
)
</script>

<template>
  <div
    class="w-full rounded-xl overflow-hidden border border-slate-700/80 shadow-2xl bg-slate-950 my-2"
    :style="{ height }"
  >
    <iframe
      :src="src"
      class="w-full h-full border-0"
      :title="title"
      loading="lazy"
    />
  </div>
</template>
