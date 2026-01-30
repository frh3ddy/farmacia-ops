# Farmacia Authentication System Design

> **Phase F Implementation Guide**

## Overview

The Farmacia authentication system is designed for retail pharmacy operations where:
- **Multiple employees** share a single iPad device
- **Fast user switching** via PIN is essential for workflow
- **Role-based access** controls what each employee can do
- **Multi-location support** allows managers to switch between stores

---

## Authentication Flow

```
┌─────────────────────────────────────────────────────────────────┐
│                    ONE-TIME DEVICE ACTIVATION                    │
│   (Owner/Manager logs in with email/password → gets deviceToken) │
└─────────────────────────────────────────────────────────────────┘
                                  │
                                  ▼
┌─────────────────────────────────────────────────────────────────┐
│                    DAILY EMPLOYEE LOGIN                          │
│              (Enter 4-6 digit PIN → get sessionToken)            │
└─────────────────────────────────────────────────────────────────┘
                                  │
                                  ▼
┌─────────────────────────────────────────────────────────────────┐
│                    AUTHENTICATED REQUESTS                        │
│   Authorization: Bearer <deviceToken>                            │
│   X-Session-Token: <sessionToken>                                │
│   X-Location-Id: <locationId>                                    │
└─────────────────────────────────────────────────────────────────┘
```

---

## Database Schema

### New Models

```prisma
// Device - represents an activated iPad/tablet
model Device {
  id            String    @id @default(uuid())
  locationId    String
  name          String    // "iPad Pro - Front Counter"
  deviceToken   String    @unique
  isActive      Boolean   @default(true)
  lastActiveAt  DateTime?
  activatedAt   DateTime  @default(now())
  activatedBy   String    // Employee ID who activated

  location Location @relation(fields: [locationId], references: [id])

  @@index([deviceToken])
  @@index([locationId])
}

// Employee - a person who can log in
model Employee {
  id           String    @id @default(uuid())
  name         String
  email        String?   @unique
  passwordHash String?   // Only for owner/manager activation
  pin          String?   // Hashed 4-6 digit PIN
  pinSalt      String?
  isActive     Boolean   @default(true)
  lastLoginAt  DateTime?
  createdAt    DateTime  @default(now())
  createdBy    String?   // Employee ID who created this employee

  // Relations
  assignments  EmployeeLocationAssignment[]
  auditLogs    AuditLog[]

  @@index([email])
}

// Role assignment per location
model EmployeeLocationAssignment {
  id         String       @id @default(uuid())
  employeeId String
  locationId String
  role       EmployeeRole
  isActive   Boolean      @default(true)
  assignedAt DateTime     @default(now())
  assignedBy String?      // Employee ID who made this assignment

  employee Employee @relation(fields: [employeeId], references: [id])
  location Location @relation(fields: [locationId], references: [id])

  @@unique([employeeId, locationId])
  @@index([employeeId])
  @@index([locationId])
}

// Audit log for all actions
model AuditLog {
  id         String   @id @default(uuid())
  employeeId String?
  deviceId   String?
  locationId String?
  action     String   // "LOGIN", "LOGOUT", "CREATE_EXPENSE", etc.
  entityType String?  // "Expense", "InventoryAdjustment", etc.
  entityId   String?
  details    Json?    // Additional context
  ipAddress  String?
  timestamp  DateTime @default(now())

  employee Employee? @relation(fields: [employeeId], references: [id])

  @@index([employeeId])
  @@index([timestamp])
  @@index([entityType, entityId])
}

enum EmployeeRole {
  OWNER
  MANAGER
  CASHIER
  ACCOUNTANT
}
```

### Update Location Model

```prisma
model Location {
  id       String  @id @default(uuid())
  squareId String? @unique
  name     String
  address  String?
  isActive Boolean @default(true)

  // Existing relations...
  inventories     Inventory[]
  expenses        Expense[]
  sales           Sale[]
  // ...

  // New relations
  devices     Device[]
  assignments EmployeeLocationAssignment[]

  createdAt DateTime @default(now())
}
```

---

## API Endpoints

### Device Activation

#### POST /auth/device/activate

Activates a device for a specific location. Requires owner/manager credentials.

**Request:**
```json
{
  "email": "owner@pharmacy.com",
  "password": "secure-password",
  "deviceName": "iPad Pro - Front Counter",
  "locationId": "L5G5MHHVDFM9X"
}
```

**Response:**
```json
{
  "success": true,
  "data": {
    "deviceToken": "dt_xxxxx...",
    "device": {
      "id": "uuid",
      "name": "iPad Pro - Front Counter",
      "activatedAt": "2026-01-30T18:00:00.000Z"
    },
    "location": {
      "id": "L5G5MHHVDFM9X",
      "name": "Main Pharmacy"
    },
    "activatedBy": {
      "id": "uuid",
      "name": "John Owner"
    }
  }
}
```

**Token Storage (iOS):**
- Store `deviceToken` in Keychain
- Token is long-lived (90 days or until deactivated)

---

### Employee Management

#### POST /employees

Create a new employee. Requires OWNER role.

**Headers:**
```
Authorization: Bearer <deviceToken>
X-Session-Token: <sessionToken>
```

**Request:**
```json
{
  "name": "Maria Garcia",
  "email": "maria@pharmacy.com",
  "pin": "1234",
  "locationId": "L5G5MHHVDFM9X",
  "role": "CASHIER"
}
```

**Response:**
```json
{
  "success": true,
  "data": {
    "id": "uuid",
    "name": "Maria Garcia",
    "email": "maria@pharmacy.com",
    "assignments": [
      {
        "locationId": "L5G5MHHVDFM9X",
        "locationName": "Main Pharmacy",
        "role": "CASHIER"
      }
    ]
  }
}
```

#### GET /employees

List employees. Returns employees visible to current user.

**Response:**
```json
{
  "success": true,
  "data": [
    {
      "id": "uuid",
      "name": "Maria Garcia",
      "isActive": true,
      "lastLoginAt": "2026-01-30T17:00:00.000Z",
      "assignments": [
        {
          "locationId": "L5G5MHHVDFM9X",
          "role": "CASHIER"
        }
      ]
    }
  ]
}
```

#### POST /employees/:id/locations

Assign employee to additional location. Requires OWNER role.

**Request:**
```json
{
  "locationId": "L6H6NIIWEGN0Y",
  "role": "MANAGER"
}
```

#### PUT /employees/:id/locations/:locationId

Update employee's role at a location.

**Request:**
```json
{
  "role": "MANAGER"
}
```

---

### PIN Login

#### POST /auth/pin

Login with PIN. Returns session token.

**Headers:**
```
Authorization: Bearer <deviceToken>
```

**Request:**
```json
{
  "pin": "1234"
}
```

**Response (Success):**
```json
{
  "success": true,
  "data": {
    "sessionToken": "st_xxxxx...",
    "expiresAt": "2026-01-30T22:00:00.000Z",
    "employee": {
      "id": "uuid",
      "name": "Maria Garcia"
    },
    "accessibleLocations": [
      {
        "locationId": "L5G5MHHVDFM9X",
        "locationName": "Main Pharmacy",
        "role": "CASHIER"
      },
      {
        "locationId": "L6H6NIIWEGN0Y",
        "locationName": "Downtown Branch",
        "role": "MANAGER"
      }
    ],
    "currentLocation": {
      "locationId": "L5G5MHHVDFM9X",
      "locationName": "Main Pharmacy",
      "role": "CASHIER"
    }
  }
}
```

**Response (Invalid PIN):**
```json
{
  "success": false,
  "message": "Invalid PIN",
  "attemptsRemaining": 2
}
```

**Response (Locked Out):**
```json
{
  "success": false,
  "message": "Account locked",
  "lockedUntil": "2026-01-30T18:05:00.000Z",
  "secondsRemaining": 300
}
```

---

### Location Switching

#### POST /auth/switch-location

Switch to a different location. Validates employee has access.

**Headers:**
```
Authorization: Bearer <deviceToken>
X-Session-Token: <sessionToken>
```

**Request:**
```json
{
  "locationId": "L6H6NIIWEGN0Y"
}
```

**Response:**
```json
{
  "success": true,
  "data": {
    "previousLocation": {
      "locationId": "L5G5MHHVDFM9X",
      "locationName": "Main Pharmacy",
      "role": "CASHIER"
    },
    "currentLocation": {
      "locationId": "L6H6NIIWEGN0Y",
      "locationName": "Downtown Branch",
      "role": "MANAGER"
    }
  }
}
```

---

### Session Management

#### POST /auth/pin/refresh

Refresh session token before expiry.

**Response:**
```json
{
  "success": true,
  "data": {
    "sessionToken": "st_new_xxxxx...",
    "expiresAt": "2026-01-31T02:00:00.000Z"
  }
}
```

#### POST /auth/logout

Logout current employee (invalidate session).

**Response:**
```json
{
  "success": true,
  "message": "Logged out successfully"
}
```

---

## Token Strategy

### Device Token
| Property | Value |
|----------|-------|
| Format | `dt_<uuid>` |
| Lifetime | 90 days |
| Storage | iOS Keychain |
| Scope | Device-level authentication |

### Session Token
| Property | Value |
|----------|-------|
| Format | `st_<uuid>` |
| Lifetime | 4 hours |
| Storage | iOS Memory (lost on app restart) |
| Scope | Employee session |

### PIN
| Property | Value |
|----------|-------|
| Length | 4-6 digits |
| Storage | Hashed with bcrypt + salt in DB |
| Lockout | 3 failed attempts → 5 min lockout |

---

## Permission Matrix

### Role Capabilities

| Capability | OWNER | MANAGER | CASHIER | ACCOUNTANT |
|------------|-------|---------|---------|------------|
| **Employees** |
| Create employee | ✅ | ❌ | ❌ | ❌ |
| View employees | ✅ | ✅ | ❌ | ❌ |
| Update employee | ✅ | ❌ | ❌ | ❌ |
| Deactivate employee | ✅ | ❌ | ❌ | ❌ |
| **Inventory** |
| View inventory | ✅ | ✅ | ✅ | ✅ |
| Receive inventory | ✅ | ✅ | ❌ | ❌ |
| Create adjustment | ✅ | ✅ | ❌ | ❌ |
| **Expenses** |
| Create expense | ✅ | ✅ | ❌ | ✅ |
| View expenses | ✅ | ✅ | ❌ | ✅ |
| Update expense | ✅ | ✅ | ❌ | ✅ |
| Delete expense | ✅ | ❌ | ❌ | ✅ |
| **Reports** |
| View COGS | ✅ | ✅ | ❌ | ✅ |
| View P&L | ✅ | ✅ | ❌ | ✅ |
| View dashboard | ✅ | ✅ | ❌ | ✅ |
| Multi-location reports | ✅ | ❌ | ❌ | ❌ |
| **Settings** |
| Manage devices | ✅ | ❌ | ❌ | ❌ |
| Manage locations | ✅ | ❌ | ❌ | ❌ |

---

## iOS Implementation

### AuthManager

```swift
import Foundation

@MainActor
class AuthManager: ObservableObject {
    static let shared = AuthManager()
    
    @Published var deviceToken: String?
    @Published var sessionToken: String?
    @Published var currentEmployee: Employee?
    @Published var currentLocation: LocationAccess?
    @Published var accessibleLocations: [LocationAccess] = []
    
    private let keychain = KeychainService()
    private let baseURL = "https://farmacia-api.railway.app"
    
    // MARK: - Device Activation
    
    func activateDevice(
        email: String,
        password: String,
        deviceName: String,
        locationId: String
    ) async throws -> DeviceActivationResponse {
        let response = try await APIClient.shared.post(
            "\(baseURL)/auth/device/activate",
            body: [
                "email": email,
                "password": password,
                "deviceName": deviceName,
                "locationId": locationId
            ]
        )
        
        // Store device token in Keychain
        try keychain.save(response.deviceToken, forKey: "deviceToken")
        deviceToken = response.deviceToken
        
        return response
    }
    
    // MARK: - PIN Login
    
    func loginWithPIN(_ pin: String) async throws -> PINLoginResponse {
        guard let deviceToken = deviceToken else {
            throw AuthError.deviceNotActivated
        }
        
        let response: PINLoginResponse = try await APIClient.shared.post(
            "\(baseURL)/auth/pin",
            body: ["pin": pin],
            headers: ["Authorization": "Bearer \(deviceToken)"]
        )
        
        sessionToken = response.sessionToken
        currentEmployee = response.employee
        accessibleLocations = response.accessibleLocations
        currentLocation = response.currentLocation
        
        return response
    }
    
    // MARK: - Location Switching
    
    func switchLocation(to locationId: String) async throws {
        guard let deviceToken = deviceToken,
              let sessionToken = sessionToken else {
            throw AuthError.notAuthenticated
        }
        
        let response: SwitchLocationResponse = try await APIClient.shared.post(
            "\(baseURL)/auth/switch-location",
            body: ["locationId": locationId],
            headers: [
                "Authorization": "Bearer \(deviceToken)",
                "X-Session-Token": sessionToken
            ]
        )
        
        currentLocation = response.currentLocation
    }
    
    // MARK: - Logout
    
    func logout() {
        sessionToken = nil
        currentEmployee = nil
        currentLocation = nil
        // Note: deviceToken remains - device stays activated
    }
    
    // MARK: - Permission Check
    
    func hasPermission(_ permission: Permission) -> Bool {
        guard let role = currentLocation?.role else { return false }
        return permission.allowedRoles.contains(role)
    }
}
```

### PIN Entry View

```swift
import SwiftUI

struct PINEntryView: View {
    @StateObject private var authManager = AuthManager.shared
    @State private var pin = ""
    @State private var error: String?
    @State private var isLoading = false
    
    var body: some View {
        VStack(spacing: 40) {
            // Title
            Text("Enter PIN")
                .font(.largeTitle)
                .fontWeight(.bold)
            
            // PIN Dots
            HStack(spacing: 20) {
                ForEach(0..<4, id: \.self) { index in
                    Circle()
                        .fill(index < pin.count ? Color.blue : Color.gray.opacity(0.3))
                        .frame(width: 20, height: 20)
                }
            }
            
            // Error Message
            if let error = error {
                Text(error)
                    .foregroundColor(.red)
                    .font(.subheadline)
            }
            
            // Number Pad
            LazyVGrid(columns: Array(repeating: GridItem(.flexible()), count: 3), spacing: 20) {
                ForEach(1...9, id: \.self) { number in
                    PINButton(title: "\(number)") {
                        addDigit("\(number)")
                    }
                }
                
                // Biometric
                PINButton(systemImage: "faceid") {
                    authenticateWithBiometrics()
                }
                
                // Zero
                PINButton(title: "0") {
                    addDigit("0")
                }
                
                // Delete
                PINButton(systemImage: "delete.left") {
                    deleteDigit()
                }
            }
            .padding(.horizontal, 40)
        }
        .disabled(isLoading)
    }
    
    private func addDigit(_ digit: String) {
        guard pin.count < 4 else { return }
        pin += digit
        
        if pin.count == 4 {
            Task { await login() }
        }
    }
    
    private func deleteDigit() {
        guard !pin.isEmpty else { return }
        pin.removeLast()
        error = nil
    }
    
    private func login() async {
        isLoading = true
        error = nil
        
        do {
            _ = try await authManager.loginWithPIN(pin)
            // Navigation handled by parent view observing authManager.currentEmployee
        } catch {
            self.error = "Invalid PIN. Please try again."
            pin = ""
        }
        
        isLoading = false
    }
    
    private func authenticateWithBiometrics() {
        // Use LocalAuthentication framework
    }
}

struct PINButton: View {
    let title: String?
    let systemImage: String?
    let action: () -> Void
    
    init(title: String, action: @escaping () -> Void) {
        self.title = title
        self.systemImage = nil
        self.action = action
    }
    
    init(systemImage: String, action: @escaping () -> Void) {
        self.title = nil
        self.systemImage = systemImage
        self.action = action
    }
    
    var body: some View {
        Button(action: action) {
            if let title = title {
                Text(title)
                    .font(.title)
                    .fontWeight(.semibold)
            } else if let systemImage = systemImage {
                Image(systemName: systemImage)
                    .font(.title)
            }
        }
        .frame(width: 80, height: 80)
        .background(Color.gray.opacity(0.1))
        .clipShape(Circle())
    }
}
```

---

## Audit Logging

All significant actions are logged:

| Action | Logged Data |
|--------|-------------|
| `LOGIN` | Employee ID, device ID, location ID |
| `LOGOUT` | Employee ID, device ID |
| `SWITCH_LOCATION` | From/to location IDs |
| `CREATE_EXPENSE` | Expense ID, amount, type |
| `CREATE_ADJUSTMENT` | Adjustment ID, type, quantity |
| `RECEIVE_INVENTORY` | Receiving ID, quantity, cost |
| `UPDATE_EMPLOYEE` | Employee ID, changed fields |

---

## Security Considerations

### PIN Security
- PINs are hashed with bcrypt (cost factor 12)
- Unique salt per employee
- 3 failed attempts → 5 minute lockout
- PIN change requires re-authentication

### Token Security
- Device tokens stored in iOS Keychain
- Session tokens stored in memory only
- Tokens are cryptographically random UUIDs
- Session tokens rotate on refresh

### Network Security
- All API calls over HTTPS
- Certificate pinning recommended for production
- Rate limiting on auth endpoints

---

## Implementation Order

1. **F.1**: Database migration (Device, Employee, EmployeeLocationAssignment, AuditLog)
2. **F.2**: Device activation endpoint
3. **F.3**: Employee CRUD endpoints
4. **F.4**: PIN login endpoint
5. **F.5**: Location switching endpoint
6. **F.6**: Auth guards and middleware
7. **F.7**: Role-based permission guards
8. **F.8**: Audit logging middleware

---

*Last Updated: 2026-01-30*
*Version: 1.0*
