import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createToolSuccessResponse } from '../response-formatter.js';
import { resetOutputFormat } from '../../config/output-format.js';

describe('response-formatter with GCF output', () => {
  beforeEach(() => {
    resetOutputFormat();
    process.env.OUTPUT_FORMAT = 'gcf';
  });

  afterEach(() => {
    resetOutputFormat();
    delete process.env.OUTPUT_FORMAT;
  });

  it('should encode structured data as GCF when OUTPUT_FORMAT=gcf', () => {
    const data = {
      rows: [
        { id: 1, name: "Alice", department: "Engineering" },
        { id: 2, name: "Bob", department: "Sales" },
        { id: 3, name: "Charlie", department: "Engineering" },
      ],
      count: 3,
      source_id: "default",
    };

    const result = createToolSuccessResponse(data);

    // Should return text/plain (GCF), not application/json
    expect(result.content[0].mimeType).toBe('text/plain');
    // Should not be JSON
    expect(() => JSON.parse(result.content[0].text)).toThrow();
    // Should contain GCF markers (pipe-delimited rows, section headers)
    expect(result.content[0].text).toContain('|');
  });

  it('should produce fewer characters than JSON for tabular data', () => {
    const data = {
      rows: Array.from({ length: 10 }, (_, i) => ({
        emp_no: 10001 + i,
        first_name: ["Alice", "Bob", "Charlie", "Diana", "Eve"][i % 5],
        last_name: ["Smith", "Jones", "Brown", "Davis", "Wilson"][i % 5],
        salary: 50000 + i * 5000,
        department: ["Eng", "Sales", "HR", "Marketing", "Finance"][i % 5],
      })),
      count: 10,
      source_id: "default",
    };

    // Compare GCF vs JSON size
    resetOutputFormat();
    process.env.OUTPUT_FORMAT = 'gcf';
    const gcfResult = createToolSuccessResponse(data);
    const gcfSize = gcfResult.content[0].text.length;

    resetOutputFormat();
    delete process.env.OUTPUT_FORMAT;
    const jsonResult = createToolSuccessResponse(data);
    const jsonSize = jsonResult.content[0].text.length;

    // GCF should be at least 30% smaller than JSON
    expect(gcfSize).toBeLessThan(jsonSize * 0.7);
  });

  it('should fall back to JSON when OUTPUT_FORMAT is not set', () => {
    resetOutputFormat();
    delete process.env.OUTPUT_FORMAT;

    const data = { rows: [{ id: 1 }], count: 1 };
    const result = createToolSuccessResponse(data);

    expect(result.content[0].mimeType).toBe('application/json');
    expect(JSON.parse(result.content[0].text)).toHaveProperty('success', true);
  });

  it('should not set isError on success responses', () => {
    const data = { rows: [], count: 0 };
    const result = createToolSuccessResponse(data);
    expect(result).not.toHaveProperty('isError');
  });
});
