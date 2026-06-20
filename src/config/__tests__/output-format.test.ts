import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { getOutputFormat, resetOutputFormat } from '../output-format.js';

describe('output-format', () => {
  beforeEach(() => {
    resetOutputFormat();
    delete process.env.OUTPUT_FORMAT;
  });

  afterEach(() => {
    resetOutputFormat();
    delete process.env.OUTPUT_FORMAT;
    vi.restoreAllMocks();
  });

  it('should default to json', () => {
    expect(getOutputFormat()).toBe('json');
  });

  it('should read OUTPUT_FORMAT env var', () => {
    process.env.OUTPUT_FORMAT = 'gcf';
    expect(getOutputFormat()).toBe('gcf');
  });

  it('should be case-insensitive for env var', () => {
    process.env.OUTPUT_FORMAT = 'GCF';
    expect(getOutputFormat()).toBe('gcf');
  });

  it('should ignore invalid values', () => {
    process.env.OUTPUT_FORMAT = 'xml';
    expect(getOutputFormat()).toBe('json');
  });

  it('should cache the result', () => {
    process.env.OUTPUT_FORMAT = 'gcf';
    expect(getOutputFormat()).toBe('gcf');
    // Change env after cache
    process.env.OUTPUT_FORMAT = 'json';
    expect(getOutputFormat()).toBe('gcf'); // Still cached
  });

  it('should reset cache with resetOutputFormat', () => {
    process.env.OUTPUT_FORMAT = 'gcf';
    expect(getOutputFormat()).toBe('gcf');
    resetOutputFormat();
    delete process.env.OUTPUT_FORMAT;
    expect(getOutputFormat()).toBe('json');
  });
});
