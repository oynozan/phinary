# Within-segment monotonicity certificate for solady expWad (exact rational arithmetic + Sturm root counting).
# Exact (floor-free) pipeline in the reduced argument t = xr (2^96 fixed point):
#   y  = (t + c1) * t / 2^96 + c2 ;  p1 = y + t - c3 ;  P = (p1*y/2^96 + c4) * t + c5*2^96
#   Q  = Horner(t) as in the code without floors ;  F = P/Q  (the code's r = trunc(p/q))
# Claims checked: (i) Q > 0 and P > 0 on the reduced range, (ii) G = P'Q - PQ' has no real root there and G > 0,
# (iii) min F' over the range (lower bound via G/Qmax^2 on chunks) * min step (79228162514) >> 2 + error bound,
# (iv) the reduced range: xr of every x in [-41.45e18, 0] lies in [T0, T1] (computed exactly at segment ends).
import sympy as sp
from fractions import Fraction as Fr
from expwad_probe import internals
from hart import sdiv
t=sp.symbols('t'); S96=sp.Integer(2)**96
c1,c2,c3,c4,c5=1346386616545796478920950773328,57155421227552351082224309758442,94201549194550492254356042504812,28719021644029726153956944680412240,4385272521454847904659076985693276
y=(t+c1)*t/S96+c2; p1=y+t-c3; P=sp.expand((p1*y/S96+c4)*t+c5*S96)
q=t-2855989394907223263936484059900
for c in [50020603652535783019961831881945,-533845033583426703283633433725380,3604857256930695427073651918091429,-14423608567350463180887372962807573,26449188498355588339934803723976023]:
    q=q*t/S96+c
Q=sp.expand(q)
# (iv) reduced range: scan every k-segment boundary exactly
L=54916777467707473351141471128
lo_x=-41446531673892822312
T0=None;T1=None
def xr_of(x): return internals(x)[1]
import math
# xr is monotone within a segment; extremes occur at segment ends -> sample all boundaries found by bisection
def kof(x): return internals(x)[0]
ends=[lo_x,0]
for k in range(kof(lo_x),1):
    a,b=lo_x,0
    if kof(a)>=k: ends.append(a); continue
    while b-a>1:
        m=(a+b)//2
        if kof(m)>=k: b=m
        else: a=m
    ends += [a,b]
xs=[xr_of(e) for e in ends]; T0=min(xs); T1=max(xs)
print("reduced-argument range [T0,T1] =",T0,T1," (L/2 =",L//2,")")
Pp=sp.Poly(P,t); Qp=sp.Poly(Q,t)
G=sp.Poly(sp.expand(sp.diff(P,t)*Q-P*sp.diff(Q,t)),t)
iv=(sp.Rational(T0),sp.Rational(T1))
print("real roots in range: P",Pp.count_roots(*iv)," Q",Qp.count_roots(*iv)," G=P'Q-PQ'",G.count_roots(*iv))
print("signs at 0: P",sp.sign(Pp.eval(0)),"Q",sp.sign(Qp.eval(0)),"G",sp.sign(G.eval(0)))
# (iii) lower bound on F' = G/Q^2 over range: min G / max Q^2 on 64 chunks (G, Q monotone? use Sturm-free bound:
# bound each poly on a chunk by |coef| interval arithmetic in the centred variable)
def poly_bounds(poly, a, b):
    # rigorous enclosure of poly on [a,b] via Taylor at mid with |t-m|<=h
    m=(a+b)/2; h=(b-a)/2
    sh=sp.Poly(poly.as_expr().subs(t,t+m),t)
    cs=sh.all_coeffs()[::-1]  # c0 + c1 u + ...
    lo=cs[0]; hi=cs[0]; rad=sum(abs(c)*h**i for i,c in enumerate(cs) if i>0)
    return lo-rad, hi+rad
mins=[]
N=64; a=sp.Rational(T0); step=(sp.Rational(T1)-sp.Rational(T0))/N
for i in range(N):
    lo,hi=a+i*step,a+(i+1)*step
    gl,_=poly_bounds(G,lo,hi); _,qh=poly_bounds(Q,lo,hi)
    mins.append(gl/qh**2)
m=min(mins)
print("rigorous lower bound on F' over range:", sp.N(m,6), " => min increase per 1-wei step of x >=", sp.N(m*79228162514,6),"internal units")
