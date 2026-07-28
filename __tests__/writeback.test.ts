/**
 * Learning-loop write-back tests — the pure safety logic only (dedupe guard,
 * eligibility, mode default). No Airtable calls.
 */

import { afterEach, describe, expect, it } from 'vitest';
import {
    getWritebackMode,
    isWritebackEligible,
    partitionAgainstHistory,
    writebackKey,
    type WritebackRow,
} from '@/lib/airtable/writeback';
import type { HistoryRow } from '@/lib/types';

const row = (o: Partial<WritebackRow>): WritebackRow => ({
    project: 'CAMINO DEL RIO',
    mark: 'P1',
    originalSpec: 'DSXB-LED-P1-40K',
    bidItem: 'GC-PPH-D25-30K',
    specManufacturer: 'LITHONIA',
    bidManufacturer: 'GLOBAL CONCEPTS',
    bidDate: '2026-07-20',
    ...o,
});

const hist = (o: Partial<HistoryRow>): HistoryRow => ({
    id: 'rec1',
    mark: '',
    bidItem: '',
    originalSpec: '',
    project: '',
    bidDate: '',
    specManufacturer: '',
    bidManufacturer: '',
    specMfrBackup: '',
    bidMfrBackup: '',
    matchType: 'EXACT',
    productCategory: '',
    specDescription: '',
    specVendor: '',
    specEnrichConfidence: '',
    premierLinkIds: [],
    thirdPartyLinkIds: [],
    ...o,
});

describe('writeback mode', () => {
    afterEach(() => {
        delete process.env.HISTORY_WRITEBACK;
        delete process.env.VERCEL_ENV;
    });

    it('defaults to dry_run when unset outside production (ship-safe default)', () => {
        delete process.env.HISTORY_WRITEBACK;
        delete process.env.VERCEL_ENV;
        expect(getWritebackMode()).toBe('dry_run');
        process.env.VERCEL_ENV = 'preview';
        expect(getWritebackMode()).toBe('dry_run');
    });

    it('defaults to live on production deployments when unset', () => {
        delete process.env.HISTORY_WRITEBACK;
        process.env.VERCEL_ENV = 'production';
        expect(getWritebackMode()).toBe('live');
    });

    it('env var always overrides the environment default', () => {
        process.env.VERCEL_ENV = 'production';
        process.env.HISTORY_WRITEBACK = 'dry_run';
        expect(getWritebackMode()).toBe('dry_run');
        process.env.HISTORY_WRITEBACK = 'off';
        expect(getWritebackMode()).toBe('off');
    });

    it('honors live and off', () => {
        process.env.HISTORY_WRITEBACK = 'live';
        expect(getWritebackMode()).toBe('live');
        process.env.HISTORY_WRITEBACK = 'off';
        expect(getWritebackMode()).toBe('off');
        process.env.HISTORY_WRITEBACK = 'garbage';
        expect(getWritebackMode()).toBe('dry_run');
    });
});

describe('dedupe guard', () => {
    it('normalizes whitespace/case/punctuation in the key', () => {
        expect(writebackKey('Job A', 'P-1', 'dsxb led p1 40k', 'gc-pph-d25-30k'))
            .toBe(writebackKey('JOB A', 'P 1', 'DSXB-LED-P1-40K', 'GC PPH D25 30K'));
    });

    it('skips rows already present in history', () => {
        const existing = [hist({ project: 'CAMINO DEL RIO', mark: 'P1', originalSpec: 'DSXB LED P1 40K', bidItem: 'GC-PPH-D25-30K' })];
        const { fresh, duplicates } = partitionAgainstHistory([row({})], existing);
        expect(fresh).toHaveLength(0);
        expect(duplicates).toHaveLength(1);
    });

    it('dedupes within the incoming batch too', () => {
        const { fresh, duplicates } = partitionAgainstHistory([row({}), row({}), row({ mark: 'P2' })], []);
        expect(fresh).toHaveLength(2);
        expect(duplicates).toHaveLength(1);
    });
});

describe('eligibility', () => {
    it('requires substantive spec, item, and project', () => {
        expect(isWritebackEligible(row({}))).toBe(true);
        expect(isWritebackEligible(row({ originalSpec: '' }))).toBe(false);
        expect(isWritebackEligible(row({ bidItem: 'x' }))).toBe(false);
        expect(isWritebackEligible(row({ project: ' ' }))).toBe(false);
    });
});
