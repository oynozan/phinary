"""Symbolic derivation/verification of the variance-matched Student-t CDF closed forms used on-chain.
F_nu^vm(d) = T_nu(d*sqrt(nu/(nu-2))), T_nu = Student-t CDF. Substituting t = d*sqrt(nu/(nu-2)):  t/sqrt(t^2+nu) = d/sqrt(d^2+nu-2)."""
import sympy as sp
d = sp.symbols('d', real=True)
def T(nu, t):  # exact Student-t CDF via integral of the pdf
    x = sp.symbols('x', real=True)
    pdf = sp.gamma(sp.Rational(nu+1, 2))/(sp.sqrt(nu*sp.pi)*sp.gamma(sp.Rational(nu, 2)))*(1 + x**2/nu)**(-sp.Rational(nu+1, 2))
    return sp.Rational(1, 2) + sp.integrate(pdf, (x, 0, t))
forms = {
 3: sp.Rational(1,2) + (sp.atan(d) + d/(d**2+1))/sp.pi,
 4: sp.Rational(1,2) + d*(d**2+3)/(2*(d**2+2)**sp.Rational(3,2)),
 5: sp.Rational(1,2) + (sp.atan(d/sp.sqrt(3)) + sp.sqrt(3)*d/(d**2+3)*(1 + 2/(d**2+3)))/sp.pi,
 6: sp.Rational(1,2) + d/(2*sp.sqrt(d**2+4))*(1 + 2/(d**2+4) + 6/(d**2+4)**2),
}
for nu, F in forms.items():
    t = d*sp.sqrt(sp.Rational(nu, nu-2))
    ref = T(nu, t)
    diff = sp.simplify(sp.diff(F, d) - sp.diff(ref, d))
    val0 = sp.simplify(F.subs(d, 0) - ref.subs(d, 0))
    dens = sp.simplify(sp.diff(F, d))
    print(f'nu={nu}: dF/dd - d(ref)/dd simplifies to {diff}; F(0)-ref(0) = {val0}; density f(d) = {sp.factor(dens)}; f(0) = {sp.nsimplify(dens.subs(d,0))} = {float(dens.subs(d,0)):.6f}')
    # tail: 1 - F ~ c d^-nu
    print('     tail 1-F ~', sp.limit((1-F)*d**nu, d, sp.oo), '* d^-%d' % nu, '| log-density slope f\'/f =', sp.simplify(sp.diff(dens, d)/dens))
# user's proposed nu=4 form check: 1/2 + (t/sqrt(t^2+4))*(1 + 2/(t^2+4)) in raw t
tt = sp.symbols('t', real=True)
user = sp.Rational(1,2) + tt/sp.sqrt(tt**2+4)*(1 + 2/(tt**2+4))
exact = sp.Rational(1,2) + tt/(2*sp.sqrt(tt**2+4))*(1 + 2/(tt**2+4))
print('raw nu=4 exact form: 1/2 + t/(2 sqrt(t^2+4)) (1 + 2/(t^2+4)); check vs integral:', sp.simplify(sp.diff(exact, tt) - sp.diff(T(4, tt), tt)), '; user form at t->inf ->', sp.limit(user, tt, sp.oo))
