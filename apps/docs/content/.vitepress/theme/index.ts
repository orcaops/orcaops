import '@fontsource-variable/inter';
import '@fontsource-variable/jetbrains-mono';
import DefaultTheme from 'vitepress/theme-without-fonts';

import './custom.css';
import Layout from './Layout.vue';

export default {
  extends: DefaultTheme,
  Layout,
};
