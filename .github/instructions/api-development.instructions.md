---
name: API Development Standards
description: REST API standards, DTOs, versioning, and HTTP semantics for Controllers and Services.
applyTo: "**/Controllers/**/*.cs,**/Services/**/*.cs"
---

# API Development

## REST Conventions
- Use resource-based routes and verbs (`GET /api/users`, `POST /api/users`).
- Use standard HTTP status codes: `200`, `201`, `204`, `400`, `401`, `403`, `404`, `409`, `500`.

## DTOs & Mapping
- Use DTOs for API surface and map to domain models via mapping profiles (AutoMapper or manual mappers).
- Validate incoming DTOs with data annotations and explicit model validation in controllers.

## Versioning
- Prefer URL versioning (`/api/v1/...`) or header-based versioning with clear deprecation notes.

## Error Responses
- Standardize error payloads: `{ errorCode: string, message: string, details?: any, correlationId?: string }`.

## Security
- Validate tokens and use claims-based authorization; avoid over-posting by restricting model binding to DTOs.

## Documentation
- Use XML comments and keep OpenAPI annotations up-to-date; include examples for expected responses.
