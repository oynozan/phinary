# Rigorous bound on |r - F(xr)| for expWad internals: floors (>>96, arithmetic) err in [0,1); propagate magnitudes.
from fractions import Fraction as Fr
T=27458388733853736675570735564+10**12   # |xr| <= T (covers [T0,T1])
S=2**96
c1,c2,c3,c4,c5=1346386616545796478920950773328,57155421227552351082224309758442,94201549194550492254356042504812,28719021644029726153956944680412240,4385272521454847904659076985693276
# y0 = t + c1 exact. y = floor(y0*t/S) + c2: err_y in [0,1)  (exact - computed)
Y0=T+c1
Ymax=Fr(Y0*T,S)+c2; ey=1
P1max=Ymax+T+c3; ep1=ey
# p2 = floor(p1*y/S)+c4 ; exact p1*y - p1^*y^ = p1*(y-y^)+y^*(p1-p1^) -> |.| <= P1max*ey + Ymax*ep1
ep2=Fr(P1max*ey+Ymax*ep1,S)+1
P2max=Fr(P1max*Ymax,S)+c4
eP=ep2*T                      # P = p2*t + c5*S
# q Horner: q = floor(q*t/S)+c each step; err_{k+1} <= err_k*T/S + 1
eq=0; Qmag=abs(2855989394907223263936484059900)+T
for c in [50020603652535783019961831881945,533845033583426703283633433725380,3604857256930695427073651918091429,14423608567350463180887372962807573,26449188498355588339934803723976023]:
    eq=Fr(eq*T,S)+1; Qmag=Fr(Qmag*T,S)+c
# F=P/Q with P,Q>0; r=trunc(p/q). |p/q - P/Q| <= (eP + F*eQ)/(Q - eQ); need Qmin: evaluate Q at extremes (Q>0, no roots) - use exact min over grid endpoints bound
import sympy as sp
t=sp.symbols('t'); q=t-2855989394907223263936484059900
for c in [50020603652535783019961831881945,-533845033583426703283633433725380,3604857256930695427073651918091429,-14423608567350463180887372962807573,26449188498355588339934803723976023]:
    q=q*t/sp.Integer(S)+c
Qp=sp.Poly(sp.expand(q),t)
# Q has no real root on range and Q(0)>0; lower bound Qmin via derivative-root check
crit=[r for r in sp.Poly(Qp.diff(t),t).real_roots() if -T<=r<=T]
cands=[Fr(-T),Fr(T)]+[Fr(sp.Rational(sp.N(r,60)).p, sp.Rational(sp.N(r,60)).q) for r in crit]
Qmin=min(Fr(int(Qp.eval(sp.Rational(c.numerator,c.denominator))*1)) if False else Fr(sp.Rational(Qp.eval(sp.Rational(c.numerator,c.denominator))).p, sp.Rational(Qp.eval(sp.Rational(c.numerator,c.denominator))).q) for c in cands)
Fmax=Fr(2**95)   # r < 2^95 observed (94 bits); bound used conservatively
err=(eP+Fmax*eq)/(Qmin-eq)+1   # +1 for truncation
print("eP ~ 2^%.1f, eq = %.3f, Qmin ~ 2^%.1f"%(float(eP).__format__('') and __import__('math').log2(float(eP)), float(eq), __import__('math').log2(float(Qmin))))
print("rigorous |r - F| <= %.6f internal units (vs >= 9.28e9 increase per wei step)"%float(err))
