<script setup lang="ts">
import { useData } from 'vitepress';
import DefaultTheme from 'vitepress/theme-without-fonts';

import DocsFooter from './DocsFooter.vue';

const { Layout } = DefaultTheme;
const { frontmatter } = useData();
</script>

<template>
  <Layout>
    <template #layout-bottom>
      <DocsFooter v-if="frontmatter.layout === 'home'" />
    </template>
  </Layout>
</template>
