# slow — technical fixture

This is an original test fixture, not official Strudel documentation. All code is source-only and has not been executed.

## Pattern.slow(factor)

`slow(factor)` stretches a pattern over more cycles. A factor of 2 makes the pattern run at half its previous speed. `fast(factor)` performs the opposite time transformation.

```javascript
s("bd sd").slow(2)
```
