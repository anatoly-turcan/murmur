import { repoDocsDir, shippedDocsDir, syncDocs } from '../src/analysis/docs.ts';

const written = syncDocs(repoDocsDir(), shippedDocsDir());
console.log(`sync-docs: ${written.length} pages → ${shippedDocsDir()}`);
