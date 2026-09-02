<script setup lang="ts">
const currentYear = new Date().getFullYear();
</script>

<template>
  <footer class="docs-footer">
    <div class="docs-footer__inner">
      <div class="docs-footer__brand">
        <div class="docs-footer__mark">
          <img
            class="docs-footer__logo docs-footer__logo--dark"
            src="/orcaops-wordmark-dark.png"
            alt="Orcaops"
            width="130"
            height="28"
          />
          <img
            class="docs-footer__logo docs-footer__logo--light"
            src="/orcaops-wordmark-light.png"
            alt="Orcaops"
            width="130"
            height="28"
          />
        </div>
        <p class="docs-footer__tagline">Check whether your coding agent finished the job.</p>
        <p class="docs-footer__agents">
          Works with Claude Code · Codex · Cursor · OpenCode · GitHub Copilot · and more
        </p>
      </div>

      <div class="docs-footer__contact">
        <span class="docs-footer__label">Contact</span>
        <a class="docs-footer__link" href="https://orcaops.ai/demo">Talk to us</a>
        <a class="docs-footer__link docs-footer__email" href="mailto:hello@orcaops.ai">
          hello@orcaops.ai
        </a>
      </div>
    </div>

    <div class="docs-footer__legal">
      <span>© {{ currentYear }} Orcaops Inc.</span>
      <span class="docs-footer__legal-note">Local CLI · Cloud for teams that want to share</span>
    </div>
  </footer>
</template>
