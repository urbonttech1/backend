import { describe, expect, it } from 'vitest';
import { organizarAccesos, type LugarGoogle } from './placeAccess';

const centro = { latitude: 37.6213, longitude: -122.379 };

describe('organizarAccesos', () => {
  it('ofrece los puntos con nombre y deja las puertas aparte', () => {
    const lugar: LugarGoogle = {
      id: 'sfo',
      displayName: { text: 'San Francisco International Airport' },
      location: centro,
      entrances: [
        { location: { latitude: 37.6172, longitude: -122.384 } },
        { location: { latitude: 37.6300, longitude: -122.380 } },
      ],
      navigationPoints: [
        {
          navigationPointToken: 'walk-1',
          displayName: { text: 'International Terminal Departures Level' },
          location: { latitude: 37.6153, longitude: -122.3901 },
          travelModes: ['WALK'],
        },
        {
          navigationPointToken: 'drive-1',
          displayName: { text: 'Domestic Garage' },
          location: { latitude: 37.6157, longitude: -122.3885 },
          travelModes: ['DRIVE', 'WALK'],
          usages: ['PARKING'],
        },
      ],
    };

    const acceso = organizarAccesos(lugar);
    expect(acceso.name).toBe('San Francisco International Airport');
    expect(acceso.entrances).toHaveLength(2);
    expect(acceso.navigationPoints).toHaveLength(2);
    expect(acceso.choices.map((p) => p.label)).toEqual([
      'Domestic Garage',
      'International Terminal Departures Level',
    ]);
    expect(acceso.choices[0].usages).toEqual(['PARKING']);
    expect(acceso.choices[0].token).toBe('drive-1');
  });

  it('pregunta las puertas por punto cardinal cuando el lugar no trae nombres', () => {
    const acceso = organizarAccesos({
      id: 'mall',
      displayName: { text: 'Mall' },
      location: { latitude: 0, longitude: 0 },
      entrances: [
        { location: { latitude: 0.001, longitude: 0 } },
        { location: { latitude: -0.001, longitude: 0 } },
      ],
    });

    expect(acceso.choices).toHaveLength(2);
    expect(acceso.choices.map((p) => p.compass).sort()).toEqual(['n', 's']);
    expect(acceso.choices.every((p) => p.source === 'entrance')).toBe(true);
    expect(acceso.choices.every((p) => p.disambiguator === null)).toBe(true);
  });

  it('numera dos puertas del mismo lado para poder distinguirlas', () => {
    const acceso = organizarAccesos({
      location: { latitude: 0, longitude: 0 },
      entrances: [
        { location: { latitude: 0.002, longitude: 0.0001 } },
        { location: { latitude: 0.003, longitude: -0.0001 } },
      ],
    });

    expect(acceso.choices.map((p) => p.compass)).toEqual(['n', 'n']);
    expect(acceso.choices.map((p) => p.disambiguator)).toEqual([1, 2]);
  });

  it('junta dos puntos que están a menos de 35 metros', () => {
    const acceso = organizarAccesos({
      displayName: { text: 'Hotel' },
      location: centro,
      navigationPoints: [
        {
          displayName: { text: 'Lobby' },
          location: { latitude: 37.62130, longitude: -122.37900 },
          travelModes: ['DRIVE'],
        },
        {
          displayName: { text: 'Lobby curb' },
          location: { latitude: 37.62132, longitude: -122.37901 },
          travelModes: ['DRIVE'],
        },
        {
          displayName: { text: 'Parking' },
          location: { latitude: 37.62500, longitude: -122.37900 },
          travelModes: ['DRIVE'],
        },
      ],
    });

    expect(acceso.navigationPoints).toHaveLength(3);
    expect(acceso.choices).toHaveLength(2);
    expect(acceso.choices.map((p) => p.label)).toEqual(['Lobby', 'Parking']);
  });

  it('con un solo punto no hay elección, pero el punto queda disponible', () => {
    const acceso = organizarAccesos({
      id: 'cafe',
      displayName: { text: 'Café' },
      location: centro,
      navigationPoints: [
        {
          displayName: { text: 'Puerta principal' },
          location: { latitude: 37.622, longitude: -122.38 },
          travelModes: ['DRIVE'],
        },
      ],
    });

    expect(acceso.choices).toHaveLength(1);
    expect(acceso.choices[0].label).toBe('Puerta principal');
  });

  it('un lugar vacío no inventa entradas', () => {
    expect(organizarAccesos(null)).toEqual({
      placeId: '',
      name: '',
      location: null,
      entrances: [],
      navigationPoints: [],
      choices: [],
    });
  });
});
