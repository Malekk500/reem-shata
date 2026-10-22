// Cambridge IGCSE Physics 0625 (2026-2028) — CONDENSED teaching scope (~2K tokens) so requests fit
// Groq's free-tier 12k tokens/min limit. Full verbatim version kept in syllabus-0625-full.js;
// switch the require in ai.js to that file if the Groq plan is upgraded. "Core" = all students;
// "[Ext]" = Extended tier only.
module.exports = `CAMBRIDGE IGCSE PHYSICS 0625 (2026-2028) — your complete teaching scope. "Core" applies to all students; "[Ext]" is Extended tier only. Stay within this scope.

1. MOTION, FORCES & ENERGY
1.1 Physical quantities & measurement: measure length/volume (ruler, measuring cylinder), time (clocks/timers), average of multiples (e.g. pendulum period). [Ext] scalar vs vector; scalars: distance, speed, time, mass, energy, temperature; vectors: force, weight, velocity, acceleration, momentum, electric & gravitational field strength; resultant of two perpendicular vectors (graphically/by calculation).
1.2 Motion: speed v=s/t; velocity = speed in a direction; average speed = total distance/total time; distance-time & speed-time graphs (rest, constant speed, accelerating, decelerating); speed from gradient of d-t graph; distance from area under v-t graph; free-fall g approximately 9.8 m/s^2. [Ext] acceleration a=change in v / change in t; acceleration from gradient of v-t graph; deceleration = negative acceleration; motion falling with/without air resistance and terminal velocity.
1.3 Mass & weight: mass = quantity of matter; weight = gravitational force W=mg; gravitational field strength g=W/m; measure mass with a balance.
1.4 Density: rho=m/V; find density of a liquid, a regular solid, and an irregular solid (volume by displacement); floating by density. [Ext] whether one liquid floats on another.
1.5 Forces: forces change size/shape/motion; load-extension graphs & Hooke's law; resultant of forces along a line; friction. [Ext] spring constant k=F/x; limit of proportionality; F=ma (force and acceleration same direction); qualitative circular motion (force perpendicular to motion; effect of speed, mass, radius); moment = force x perpendicular distance; principle of moments; centre of gravity; equilibrium conditions.
1.6 Momentum [Ext]: momentum p=mv; impulse = F x change in t = change in momentum; conservation of momentum along a line; resultant force = rate of change of momentum.
1.7 Energy, work & power: energy stores (kinetic, gravitational potential, chemical, elastic/strain, nuclear, electrostatic, internal/thermal) and transfers (mechanically, electrically, by heating, by waves); conservation of energy; KE=(1/2)mv^2; change in GPE = mg x change in h; work W=Fd; energy resources (fossil fuels, nuclear, biofuel, hydro, geothermal, solar, wind) — how each generates electricity, whether renewable, advantages/disadvantages, the Sun as source of most; power P=W/t; efficiency = useful output / total input (x100%). [Ext] Sankey diagrams; efficiency of transfers.
1.8 Pressure: p=F/A; pressure in a liquid increases with depth and density; change in pressure = rho x g x change in h.

2. THERMAL PHYSICS
2.1 Kinetic particle model: solids/liquids/gases (arrangement, separation, motion); changes of state; effect of temperature & pressure on a gas; Brownian motion (evidence of moving particles). [Ext] microscopic explanation of gas pressure and of temperature; pV = constant at constant temperature.
2.2 Thermal properties: thermal expansion of solids, liquids, gases (uses & consequences); specific heat capacity E=mc x change in temperature. [Ext] latent heat; specific latent heat E=mL; melting, boiling, evaporation, condensation, solidification; evaporation vs boiling and cooling by evaporation.
2.3 Transfer of thermal energy: conduction (metals vs non-metals), convection (fluids, density change), radiation (infrared; effect of surface colour/texture, temperature and area); everyday applications & consequences. [Ext] particle explanation of conduction; good/bad emitters & absorbers.

3. WAVES
3.1 General properties: transverse vs longitudinal; wavefronts; amplitude, wavelength, frequency, period, speed; v=f x lambda; T=1/f; reflection, refraction, diffraction (effect of gap size/wavelength).
3.2 Light: reflection (law; plane-mirror image is virtual, upright, same size, laterally inverted); refraction; refractive index n=sin i/sin r. [Ext] n=1/sin c; critical angle & total internal reflection; optical fibres. Thin converging lens (ray diagrams; real & virtual images; magnifying glass); dispersion of white light by a prism; monochromatic light. [Ext] long/short sight.
3.3 Electromagnetic spectrum: order radio, microwave, infrared, visible, ultraviolet, X-ray, gamma; uses and dangers of each; all travel at approximately 3x10^8 m/s in vacuum. [Ext] analogue vs digital signals.
3.4 Sound: longitudinal, needs a medium; human range 20 Hz to 20 kHz; speed in air approximately 330-350 m/s; compressions & rarefactions; loudness (amplitude), pitch (frequency); echoes. [Ext] ultrasound and its uses.

4. ELECTRICITY & MAGNETISM
4.1 Magnetism: magnetic materials; poles attract/repel; induced magnetism; magnetic field lines (direction & strength); permanent magnets vs electromagnets and uses.
4.2 Electrical quantities: positive/negative charge, charging by friction; conductors & insulators; electric field & field lines; current I=Q/t; e.m.f. and potential difference (volt); ammeter (series) & voltmeter (parallel); resistance R=V/I; I-V graphs (resistor, filament lamp, diode); electrical energy E=IVt; power P=IV. [Ext] R=rho x L/A; resistance vs length/area; P=I^2R.
4.3 Circuits: circuit symbols & diagrams; series vs parallel; current same in series, splits/adds in parallel; p.d. adds in series, same across parallel; series resistance R=R1+R2+...; components: fixed/variable resistors, thermistor (temperature), LDR (light), diode; their action & use. [Ext] combined parallel resistance; potential divider.
4.4 Electrical safety: hazards (damaged insulation, overheating cables, damp); fuses, circuit breakers, earthing, double insulation; choosing a fuse; live/neutral/earth.
4.5 Electromagnetic effects: electromagnetic induction (a moving magnet/wire induces an e.m.f.; factors affecting size & direction); a.c. generator; magnetic effect of a current (field around wire & solenoid); force on a current-carrying conductor in a field (motor effect; direction & factors); d.c. motor; transformers (Vp/Vs = Np/Ns). [Ext] Lenz's law; VpIp=VsIs; high-voltage transmission; the loudspeaker.

5. NUCLEAR PHYSICS
5.1 Nuclear model: nucleus of protons & neutrons with orbiting electrons; nuclide notation with nucleon (A) and proton (Z) numbers; isotopes; ions. [Ext] scattering evidence for the nuclear model.
5.2 Radioactivity: background radiation & sources; detection (e.g. GM tube); alpha, beta, gamma — nature, charge, mass, ionising & penetrating power, deflection in fields; decay/nuclear equations (alpha, beta); decay is random & spontaneous; half-life (definition & calculations from data or graphs); safety/handling/storage; uses (medical, industrial, dating).

6. SPACE PHYSICS
6.1 Earth & the Solar System: Earth's rotation (day/night) and orbit (year); the Moon's orbit; the Solar System (Sun, eight planets and their order, dwarf planets, asteroids, comets); gravitational attraction keeps objects in orbit. [Ext] orbital speed v = 2 x pi x r / T; why orbital duration differs with distance; a comet's changing speed.
6.2 Stars & the Universe: the Sun is a star, mainly hydrogen & helium, powered by nuclear fusion; galaxies (the Milky Way); the light-year; redshift of light from distant galaxies is evidence the Universe is expanding (supports the Big Bang). [Ext] stellar life cycle (nebula, protostar, stable star, red giant/supergiant, white dwarf or supernova then neutron star/black hole); Hubble's law H0=v/d; age of the Universe approximately 1/H0; current H0 approximately 2.2x10^-18 per second.`;
