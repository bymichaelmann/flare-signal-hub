import { describe, expect, it } from 'vitest';
import { buildDashboardData, renderDashboard } from '../src/dashboard.js';

function render(mode: string): string {
  return renderDashboard(
    buildDashboardData([], {}, mode, '2025-01-01T00:00:00.000Z'),
  );
}

describe('renderDashboard footer data-source honesty', () => {
  it('claims on-chain FTSOv2 data only in live mode', () => {
    const html = render('live');
    expect(html).toContain('on-chain price feeds');
    expect(html).toContain('FtsoV2.getFeedByIdInWei');
    expect(html).not.toContain('synthetic seeded series');
  });

  it('discloses fixture data instead of claiming on-chain prices', () => {
    const html = render('fixture');
    expect(html).toContain('synthetic seeded series');
    expect(html).toContain('fixture mode');
    expect(html).not.toContain('on-chain price feeds');
    expect(html).not.toContain('FtsoV2.getFeedByIdInWei');
  });

  it('always keeps the informational-only disclaimer', () => {
    for (const mode of ['live', 'fixture']) {
      expect(render(mode)).toContain('not financial advice');
    }
  });
});
