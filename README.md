# Monte Carlo Investment Simulation

Projects what a brokerage account could grow to from what's invested and what's held in
cash. It can add yearly income, show amounts in today's dollars, and simulate 2,000
possible futures with good and bad years to show the range of outcomes.

## Settings

**Invested**: money in stocks, funds and other holdings.
- *Principal*: how much is invested now.
- *Annual return*: how much it grows each year. With Range of outcomes on, this is the
  typical year's return rather than every year's.

**Not invested**: cash held in the account.
- *Principal*: how much cash there is now.
- *Annual growth*: the interest it earns each year. Cash always grows at this steady
  rate, even in the simulation.

**Yearly income** (switch): money added to the account every year.
- *Amount per year*: added in 12 equal deposits, one at the end of each month.
- *Split*: how much of it goes to Invested and how much to Not invested.

**Time**: how many years to project, from 1 to 80.

**Range of outcomes** (switch): simulates 2,000 possible futures in which the invested
part has good and bad years, each independent of the last. It shows the typical result,
the range 8 in 10 simulations end in, and the chance of ending with less than you put in.
- *Swings like*: how much the invested part's return changes from year to year, set to
  match US history (1928 to 2025) for a mix of stocks and bonds: all stocks (19%), 80%
  stocks (16%), 60% stocks (12%) or 40% stocks (9%).
- *Yearly swings*: the same as a number, from 0% to 60%. Typing your own selects Custom.
- *Reshuffle*: draws a new set of 2,000 futures. The same settings always show the same
  futures until you reshuffle.

**Inflation** (switch): shows future amounts in today's dollars.
- *Estimate*: Fed target (2.3%, its 2% goal plus the usual gap by which consumer prices
  run higher), long-run forecast (2.5%, about what official and market forecasts expect)
  or US history (3%, the average from 1928 to 2025).
- *Per year*: the same as a number, from 0% to 10%. Typing your own selects Custom.
