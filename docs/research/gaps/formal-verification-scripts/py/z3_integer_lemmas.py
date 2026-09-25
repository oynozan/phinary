# Machine-checked (z3, unbounded integer arithmetic, NIA) proofs of the quote-layer integer lemmas.
# Each "prove" asserts the negation and expects UNSAT. Floor/ceil are encoded by their defining inequalities,
# isqrt by s^2 <= X < (s+1)^2. These are the MATH statements; EVM no-overflow bounds are a separate (linear) check.
import time
from z3 import *
def prove(name, hyps, goal, timeout=600):
    s=SolverFor("QF_NIA"); s.set("timeout", timeout*1000)
    s.add(*hyps); s.add(Not(goal))
    t=time.time(); r=s.check(); dt=time.time()-t
    tag="PROVED" if r==unsat else ("COUNTEREXAMPLE" if r==sat else "UNKNOWN")
    print(f"{name:55s} {tag:15s} {dt:7.2f}s")
    if r==sat: print("   model:", s.model())
    return r
I=Int
beta,lam,R,s,q,D,A,A1,A2,q1,q2,I0,a,b,Q=Ints('beta lam R s q D A A1 A2 q1 q2 I0 a b Q')
def floordiv(x,n,y): return And(n*y<=x, x<n*(y+1))          # y = floor(x/n), n>0
def ceildiv(x,n,y):  return And(n*y>=x, x>n*(y-1))          # y = ceil(x/n),  n>0

# ---- Lemma S (buy, exact-in): q = floor((isqrt(beta^2+4 lam R) - beta)/(2 lam)) is the max q>=0 with lam q^2+beta q <= R
Hb=[beta>0, lam>0, R>=0, s>=0, s*s<=beta*beta+4*lam*R, beta*beta+4*lam*R<(s+1)*(s+1), floordiv(s-beta,2*lam,q)]
prove("Lemma S buy: feasible", Hb, lam*q*q+beta*q<=R)
prove("Lemma S buy: maximal", Hb, lam*(q+1)*(q+1)+beta*(q+1)>R)
prove("Lemma S buy: q >= 0", Hb, q>=0)
# ---- Lemma S (sell, exact-out): q = ceil((beta - isqrt(beta^2-4 lam R))/(2 lam)), min q with beta q - lam q^2 >= R
Hs=[beta>0, lam>0, R>=0, 4*lam*R<=beta*beta, s>=0, s*s<=beta*beta-4*lam*R, beta*beta-4*lam*R<(s+1)*(s+1), ceildiv(beta-s,2*lam,q)]
prove("Lemma S sell: sufficient WITHOUT band (expect CEX)", Hs, beta*q-lam*q*q>=R, 120)
prove("Lemma S sell: sufficient WITH band 2 lam q <= beta", Hs+[2*lam*q<=beta], beta*q-lam*q*q>=R)
prove("Lemma S sell: minimal", Hs+[2*lam*q<=beta, q>0], beta*(q-1)-lam*(q-1)*(q-1)<R)
# ---- Lemma A (additivity) for the cost numerator N(I,q) = lam q^2 + beta(I) q, beta(I) = 2e6 a + 2 lam I
def N(I_,q_,p): return lam*q_*q_ + (2*10**6*p + 2*lam*I_)*q_
prove("Lemma A: N(I,q1)+N(I+q1,q2) == N(I,q1+q2)", [], N(I0,q1,a)+N(I0+q1,q2,a)==N(I0,q1+q2,a))
# ---- Theorem N, exact-out buys: ceil(N1/D)+ceil(N2/D) >= ceil((N1+N2)/D)
c1,c2,c12=Ints('c1 c2 c12'); N1,N2=Ints('N1 N2')
prove("Thm N exact-out buy: ceil+ceil >= ceil(sum)", [D>0, ceildiv(N1,D,c1), ceildiv(N2,D,c2), ceildiv(N1+N2,D,c12)], c1+c2>=c12)
prove("Thm N exact-in sell: floor+floor <= floor(sum)", [D>0, floordiv(N1,D,c1), floordiv(N2,D,c2), floordiv(N1+N2,D,c12)], c1+c2<=c12)
# Theorem N exact-in buys: q1 feasible for A1 at I0, q2 feasible for A2 at I0+q1, Q maximal for A1+A2 at I0 => q1+q2 <= Q
beta0=2*10**6*a+2*lam*I0
Hn=[lam>0, D>0, a>0, beta0>0, q1>=0, q2>=0, Q>=0, A1>=0, A2>=0,
    N(I0,q1,a)<=A1*D, N(I0+q1,q2,a)<=A2*D,                      # feasibility of the two legs (from Lemma S)
    N(I0,Q,a)<=(A1+A2)*D, N(I0,Q+1,a)>(A1+A2)*D]                  # maximality of the single trade (Lemma S)
prove("Thm N exact-in buy: q1+q2 <= q(A1+A2)", Hn, q1+q2<=Q)
# ---- E2 round trip (exact-out buy at ask a, then exact-in sell same q at bid b<=a from I+q): trader never gains
cost,back=Ints('cost back')
def M(I_,q_,p): return (2*10**6*p + 2*lam*I_)*q_ - lam*q_*q_
He=[lam>=0, D>0, q>0, b<=a, ceildiv(N(I0,q,a),D,cost), floordiv(M(I0+q,q,b),D,back)]
prove("E2: floor(M_b(I+q,q)/D) <= ceil(N_a(I,q)/D)", He, back<=cost)
prove("E2 identity: N_a(I,q) - M_b(I+q,q) == 2e6 (a-b) q", [], N(I0,q,a)-M(I0+q,q,b)==2*10**6*(a-b)*q)
# ---- E1 amount form (same state): ceil(N_a/D) + (q - floor(M_b/D)) >= q  <=>  N_a >= M_b
prove("E1: N_a(I,q) - M_b(I,q) == 2e6(a-b)q + 2 lam q^2", [], N(I0,q,a)-M(I0,q,b)==2*10**6*(a-b)*q+2*lam*q*q)
