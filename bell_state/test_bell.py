import numpy as np
from qiskit import QuantumCircuit
from qiskit.quantum_info import Statevector

from bell_lib import build_bell_circuit, get_statevector


def test_statevector_bell():
    qc = build_bell_circuit()
    sv = get_statevector()
    # Expected Bell state (|00> + |11>)/sqrt(2)
    expected = np.array([1/np.sqrt(2), 0, 0, 1/np.sqrt(2)], dtype=complex)
    # Compare up to global phase
    fidelity = abs(np.vdot(expected, sv.data))
    assert np.isclose(fidelity, 1.0, atol=1e-8)
