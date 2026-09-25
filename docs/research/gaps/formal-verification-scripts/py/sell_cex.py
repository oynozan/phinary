import math
D=2*10**24
u,v=167,3*10**7
lam=2*u*u; b=2*10**6*u*v; i0=0; A=v*v
beta=2*10**6*b+2*lam*i0
bb=beta*beta; f=4*lam*A*D
print("lam",lam,"b(WAD)",b,"A",A,"disc",bb-f)
s=math.isqrt(bb-f); q=-(-(beta-s)//(2*lam))
num=beta*q-lam*q*q
print("q",q,"vertex",beta/(2*lam),"proceeds floor",num//D,"A",A,"shortfall numerator",A*D-num, "end marginal*2e6", beta-2*lam*q)
