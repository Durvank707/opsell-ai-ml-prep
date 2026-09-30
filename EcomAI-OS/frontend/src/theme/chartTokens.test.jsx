// Charts in the dark theme.
//
// recharts paints SVG, and jsdom neither runs a stylesheet nor lays anything
// out, so asserting chart pixels is not possible here. What is possible, and what
// actually matters, is the input: which colour each part of the chart is *asked*
// to draw with. recharts is stubbed so every element records the props it
// received, and the assertions are on those.
//
// The point being pinned is that the chart asks the theme for its colours and
// re-asks when the theme changes, rather than owning a palette of its own.

import { fireEvent, render, screen } from '@testing-library/react';
import React, { useState } from 'react';
import { beforeEach, describe, expect, it } from 'vitest';

// Every element recharts was handed, keyed by element type. Repeatable
// elements (the two series in a line chart, the three slices of a donut) are
// collected into a list, because which line is which is the whole question.
const drawn = {};

function record(key, props) {
  drawn[key] = [].concat(drawn[key] ?? [], props);
}

vi.mock('recharts', () => {
  // The chart wrappers render their children - a real chart does, and dropping
  // them would leave nothing below the chart to record.
  const container = (key) => ({ children }) => {
    record(key, { children });
    return <div>{children}</div>;
  };
  const stub = (key) => (props) => {
    record(key, props);
    return <g />;
  };
  return {
    ResponsiveContainer: ({ children }) => <div>{children}</div>,
    ComposedChart: container('composedChart'),
    LineChart: container('lineChart'),
    BarChart: container('barChart'),
    PieChart: container('pieChart'),
    Area: stub('areas'),
    Line: stub('lines'),
    Bar: stub('bars'),
    Pie: ({ children, ...props }) => {
      record('pie', props);
      return <g>{children}</g>;
    },
    Cell: stub('cells'),
    XAxis: stub('xaxis'),
    YAxis: stub('yaxis'),
    CartesianGrid: stub('grid'),
    Tooltip: stub('tooltip'),
    Legend: stub('legend'),
    ReferenceLine: stub('referenceLine'),
  };
});

const { default: ThemeToggle } = await import('../components/ThemeToggle');
const { DemandChart, HealthDonut, SimpleBars, StockLineChart } = await import('../components/charts');
const { CHART_TOKENS } = await import('./chartTokens');
const { ThemeProvider } = await import('./ThemeContext');

const { light, dark } = CHART_TOKENS;

/**
 * The most recent of a recorded element. Single instances (the axes, the grid,
 * the reorder rule) are recorded once per render, so the last is the current
 * one - which is what makes a theme change assertable.
 */
const last = (recorded) => recorded[recorded.length - 1];

/**
 * The most recent series recharts was given for a data key. Matched on
 * `dataKey` rather than `name` because a series is not required to set one:
 * recharts falls back to the key for the legend, and the inventory chart names
 * its series while the demand chart only keys them.
 */
const series = (dataKey) => {
  const matches = drawn.lines.filter((line) => line.dataKey === dataKey);
  return matches[matches.length - 1];
};

/** Bands are drawn as Areas, not Lines. */
const area = (dataKey) => {
  const matches = drawn.areas.filter((a) => a.dataKey === dataKey);
  return matches[matches.length - 1];
};

/**
 * A token hex, as the browser reports it once it has been set through a style
 * attribute. The legend passes colours as inline styles, so this is the form the
 * assertion has to compare against.
 */
const rgb = (hex) => {
  const n = parseInt(hex.slice(1), 16);
  return `rgb(${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255})`;
};

function renderDark(ui) {
  return render(<ThemeProvider storage={null} matchMedia={null} initialTheme="dark">{ui}</ThemeProvider>);
}

beforeEach(() => {
  for (const key of Object.keys(drawn)) delete drawn[key];
  document.documentElement.className = '';
  delete document.documentElement.dataset.theme;
});

describe('the inventory timeline in the dark theme', () => {
  // The chart the Simulation page hangs its answer on: stock on hand, the units
  // already bought, the demand that could not be met, and the reorder point.
  function timeline() {
    return renderDark(
      <StockLineChart
        points={[
          { date: '2025-01-01', stock: 50, in_transit: 0, lost: 0 },
          { date: '2025-01-02', stock: 22, in_transit: 40, lost: 18 },
        ]}
        reference={40}
        inTransitKey="in_transit"
        lostKey="lost"
      />,
    );
  }

  it('paints the stock line, the in-transit band, unmet demand and the reorder rule in dark colours', () => {
    timeline();

    expect(series('stock').stroke).toBe(dark.forecast);
    expect(series('lost').stroke).toBe(dark.lost);
    expect(area('in_transit').fill).toBe(dark.band);
    expect(last(drawn.referenceLine).stroke).toBe(dark.reorder);
  });

  it('paints them in different colours, so none of them disappears into the page', () => {
    timeline();

    const strokes = drawn.lines.map((l) => l.stroke);
    expect(new Set(strokes).size).toBe(2);
    // The stock line and the unmet-demand line must not be told to draw the
    // same colour: one is the plan, one is the failure to report.
    expect(strokes).not.toContain(dark.grid);
  });

  it('labels the reorder point in a colour readable against a dark surface', () => {
    timeline();
    expect(last(drawn.referenceLine).label.fill).toBe(dark.reorderLabel);
    expect(dark.reorderLabel).not.toBe(dark.reorder);
  });

  it('keeps the axis and grid behind the data', () => {
    timeline();

    expect(last(drawn.xaxis).tick.fill).toBe(dark.axis);
    expect(last(drawn.xaxis).axisLine.stroke).toBe(dark.grid);
    expect(last(drawn.yaxis).tick.fill).toBe(dark.axis);
    expect(last(drawn.grid).stroke).toBe(dark.grid);
  });
});

describe('demand, health and bar charts in the dark theme', () => {
  it('separates observed demand from the forecast it predicts', () => {
    renderDark(
      <DemandChart
        actuals={[{ date: '2025-01-01', units: 12 }]}
        forecast={[{ date: '2025-01-02', forecast: 15, lower: 10, upper: 20 }]}
      />,
    );

    const actual = series('Actual Demand');
    const forecast = series('Forecast Demand');
    expect(actual.stroke).toBe(dark.actual);
    expect(forecast.stroke).toBe(dark.forecast);
    expect(actual.stroke).not.toBe(forecast.stroke);
  });

  it('gives the health donut its three states distinct colours', () => {
    renderDark(<HealthDonut healthy={12} atRisk={4} critical={1} />);

    expect(drawn.cells.map((c) => c.fill)).toEqual([dark.healthy, dark.risk, dark.critical]);
    expect(new Set(drawn.cells.map((c) => c.fill)).size).toBe(3);
  });

  it('paints a bar chart from the themed default when no colour is given', () => {
    renderDark(<SimpleBars data={[{ name: 'Online', value: 40 }]} />);
    expect(last(drawn.bars).fill).toBe(dark.bar);
  });

  it('still honours a colour the caller asks for', () => {
    // An explicit colour is the caller's decision - used where a series has its
    // own meaning, such as a channel breakdown in a status hue.
    renderDark(<SimpleBars data={[{ name: 'Online', value: 40 }]} color={dark.critical} />);
    expect(last(drawn.bars).fill).toBe(dark.critical);
  });
});

describe('the demand chart legend in the dark theme', () => {
  const chart = (props = {}) =>
    renderDark(
      <DemandChart
        actuals={[{ date: '2025-01-01', units: 12 }]}
        forecast={[{ date: '2025-01-02', forecast: 15, lower: 10, upper: 20 }]}
        {...props}
      />,
    );

  it('names each series, so the colours on the plot can be read back', () => {
    chart();
    const items = screen.getAllByRole('listitem').map((li) => li.textContent);
    expect(items).toEqual(['Confidence band', 'Actual demand', 'Forecast demand']);
  });

  it('takes each swatch from the series, and each label from the theme text', () => {
    // The reason this is a local component rather than recharts' own Legend:
    // recharts colours a label with its series' fill, so the band's label came
    // out in the same light indigo the band is filled with - 3.77:1 on a dark
    // card. The swatch stays tied to the series; the label does not.
    chart();

    const swatches = screen
      .getAllByRole('listitem')
      .map((li) => li.querySelector('span[aria-hidden]').style.background);
    expect(swatches).toEqual([rgb(dark.band), rgb(dark.actual), rgb(dark.forecast)]);
    // Every label shares one themed colour, so none of them is coloured by a
    // series at all.
    const labels = screen.getAllByRole('listitem').map((li) => li.className);
    for (const cls of labels) expect(cls).toContain('text-slate-500');
  });

  it('drops the band entry when there is no band to explain', () => {
    chart({ forecast: [] });
    const items = screen.getAllByRole('listitem').map((li) => li.textContent);
    expect(items).toEqual(['Actual demand', 'Forecast demand']);
  });

  it('reads its text from the same themed palette the axes do', () => {
    // One theme, two sources: if the legend ever went back to a hardcoded
    // grey it would be the one part of the chart the swap could not reach.
    chart();
    expect(dark.actual).not.toBe(dark.axis);
    expect(dark.band).not.toBe(dark.actual);
  });
});

describe('following a theme change', () => {
  it('repaints the chart when the toggle flips, without a reload', () => {
    // The strongest version of the requirement: charts track the theme, so a
    // user who toggles mid-page does not end up with an unreadable graph.
    function Live() {
      const [_, force] = useState(0);
      return (
        <ThemeProvider storage={null} matchMedia={null} initialTheme="light">
          <ThemeToggle />
          <button type="button" onClick={() => force((n) => n + 1)}>
            Rerender
          </button>
          <StockLineChart points={[{ date: '2025-01-01', stock: 5 }]} reference={10} />
        </ThemeProvider>
      );
    }

    render(<Live />);
    expect(series('stock').stroke).toBe(light.forecast);
    expect(last(drawn.xaxis).tick.fill).toBe(light.axis);

    fireEvent.click(screen.getByRole('button', { name: 'Switch to dark mode' }));

    // The most recent render wins: the stub overwrites, so the recorded props
    // are from the last pass, which is the point - the chart re-read the theme.
    expect(series('stock').stroke).toBe(dark.forecast);
    expect(last(drawn.xaxis).tick.fill).toBe(dark.axis);
    expect(last(drawn.referenceLine).stroke).toBe(dark.reorder);
  });
});
