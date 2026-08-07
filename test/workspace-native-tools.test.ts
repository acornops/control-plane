import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { getWorkspaceNativeTool } from '../src/services/workspace-native-tools.js';

describe('workspace native tool definitions', () => {
  it('advertises a concise document tool with descriptive trusted arguments', () => {
    const tool = getWorkspaceNativeTool('documents.create');
    assert.ok(tool);
    assert.equal(tool.description, 'Create a PDF or Markdown document.');

    const properties = tool.inputSchema.properties as Record<string, Record<string, unknown>>;
    assert.deepEqual(tool.inputSchema.required, ['title', 'markdown']);
    assert.equal(tool.inputSchema.additionalProperties, false);
    assert.equal(properties.title.description, 'Short title displayed for the generated document.');
    assert.equal(
      properties.markdown.description,
      'Complete document body in Markdown, including headings and body. Do not wrap the entire document in an outer fenced code block.'
    );
    assert.equal(
      properties.format.description,
      'Output file format. Use `pdf` for a rendered PDF or `markdown` for a Markdown file. Omit to create a PDF.'
    );
    assert.deepEqual(properties.format.enum, ['pdf', 'markdown']);
    assert.equal('default' in properties.format, false);
    assert.equal('provenance' in properties, false);
  });
});
